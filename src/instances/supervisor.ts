import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { MirrorEndpoint } from '../mirror/endpoint.js'
import { TICKET_COOKIE } from '../mirror/rewrite.js'
import { asSocket, sshUpstream, tcpUpstream, type UpstreamConnector } from '../mirror/upstream.js'
import type { RemoteDeskInstance } from '../config.js'
import { SshConnection } from '../ssh/manager.js'
import { sshProcessHandle } from '../ssh/process.js'
import { decideAttach } from './attach.js'
import { exchangeSession, findReadyUrl, type SessionExchange } from './readiness.js'
import { preflight, type PreflightCheck } from './preflight.js'
import { POSIX_SHELL_PREFIX, planFor, wslShellArgv } from './spec.js'
import { parseVersion, resolveUpdatePlan, type VersionProbe } from './update.js'
import {
  instanceById,
  labelOf,
  type HostSelfEndpoint,
  type InstanceConfigSource,
  type InstancePhase,
  type InstanceSnapshot,
  type SupervisorDeps,
  type UpdateOutcome,
  type UpdateRecord,
} from './types.js'

/** 子进程句柄（结构化声明，避免依赖未随发行版发布 .d.ts 的包）。 */
interface SubprocessHandleLike {
  done: Promise<{ exitCode: number | null; signal: string | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
  collected: {
    stdout?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
    stderr?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
  }
}

export interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    env?: NodeJS.ProcessEnv
  }): SubprocessHandleLike
}

const MAX_LOG_LINES = 600
/** 从 spawn 到打印就绪行的上限；WSL 首次启动可能较慢。 */
const READY_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 200
const PROBE_TIMEOUT_MS = 4_000
/** 吸附时等宿主能力（端口 + 进程令牌）就位的上限。 */
const ATTACH_READY_TIMEOUT_MS = 20_000
/** 吸附时的轮询间隔，以及会话换取的退避基数。 */
const ATTACH_POLL_MS = 400
/** 会话换取最多试几次（启动早期 `/` 还没被前端兜底认领时会 404）。 */
const ATTACH_EXCHANGE_ATTEMPTS = 8
/** 镜像预热的总预算与并发（纯尽力而为，超时就到此为止）。 */
const WARMUP_TIMEOUT_MS = 60_000
const WARMUP_CONCURRENCY = 3
/** 版本探测超时：远端要 source nvm，给宽一点。 */
const VERSION_TIMEOUT_MS = 30_000
/** 更新/回滚超时：包管理器可能拉很久。 */
const UPDATE_TIMEOUT_MS = 10 * 60_000
/** 命令输出进日志环时最多保留的行数（避免 npm 刷屏把环冲掉）。 */
const UPDATE_LOG_LINES = 40

interface Runtime {
  handle?: SubprocessHandleLike
  /** SSH 实例的连接（控制面与数据面共用一条）。 */
  ssh?: SshConnection
  endpoint?: MirrorEndpoint
  cookie?: string
  remotePort?: number
  readyUrl?: string
  upstreamDescription?: string
  phase: InstancePhase
  since: number
  detail: string
  error?: string
  exit?: { code: number | null; signal: string | null }
  stdoutOffset: number
  stderrOffset: number
  stdoutPending: string
  stderrPending: string
  lines: string[]
  /** lines[0] 的全局行号，客户端据此增量拉取。 */
  base: number
  /**
   * 本轮启动的日志起点（全局行号）。
   *
   * 必须记住它：日志环是跨轮次保留的，上一次运行的就绪行还在里面——不划清界限的话，
   * 重启时会立刻"找到"上一轮的 URL，拿着旧端口去换 cookie（实测就是这个症状）。
   */
  readyFromGlobal: number
  poll?: NodeJS.Timeout
  busy: boolean
  /** 这一轮是「吸附」宿主自身（没有子进程句柄），而不是拉起进程。 */
  attached?: boolean
  /**
   * 上一次镜像端点用的端口。
   *
   * 复用同一个端口 = 复用同一个 origin：浏览器缓存（那几百 KB 前端 bundle）与镜像里那套 DSH
   * 自己的 localStorage（界面偏好、上次看的会话）都留得住，切回来不用重新渲染一遍。
   */
  lastMirrorPort?: number
  /** 已知的 DSH 版本，以及最近一次更新/回滚。 */
  version?: string
  lastUpdate?: UpdateRecord
}

/**
 * 实例监管器：把「配置里的一条实例」变成「一个跑着的 DSH + 一个镜像端点」。
 *
 * 生命周期绑定宿主：子进程由 ctx.subprocess 托管，宿主退出即随之终止——这是有意为之，
 * 免得留下没人管的孤儿进程。
 */
export class InstanceSupervisor {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly config: InstanceConfigSource
  private readonly deps: SupervisorDeps
  private readonly subprocess: () => SubprocessLike | undefined

  constructor(
    config: InstanceConfigSource,
    deps: SupervisorDeps,
    subprocess: () => SubprocessLike | undefined,
  ) {
    this.config = config
    this.deps = deps
    this.subprocess = subprocess
  }

  list(): InstanceSnapshot[] {
    return this.config.instances
      .map((instance) => this.snapshot(instance.id))
      .filter((value): value is InstanceSnapshot => value !== undefined)
  }

  snapshot(id: string): InstanceSnapshot | undefined {
    const instance = instanceById(this.config, id)
    if (instance === undefined) return undefined
    const runtime = this.runtimeOf(id)
    return {
      id: instance.id,
      kind: instance.kind,
      label: labelOf(instance),
      enabled: instance.enabled,
      phase: runtime.phase,
      since: runtime.since,
      detail: runtime.detail,
      ...(runtime.remotePort === undefined ? {} : { remotePort: runtime.remotePort }),
      ...(runtime.readyUrl === undefined ? {} : { readyUrl: runtime.readyUrl }),
      ...(runtime.endpoint?.baseUrl === undefined ? {} : { mirrorBaseUrl: runtime.endpoint.baseUrl }),
      ...(runtime.endpoint?.entryUrl === undefined ? {} : { mirrorEntryUrl: runtime.endpoint.entryUrl }),
      ...(runtime.upstreamDescription === undefined ? {} : { upstream: runtime.upstreamDescription }),
      ...(runtime.error === undefined ? {} : { error: runtime.error }),
      ...(runtime.exit === undefined ? {} : { exit: runtime.exit }),
      ...(runtime.attached === true ? { attached: true } : {}),
      ...(runtime.version === undefined ? {} : { version: runtime.version }),
      ...(runtime.lastUpdate === undefined ? {} : { lastUpdate: runtime.lastUpdate }),
      logs: { nextOffset: runtime.base + runtime.lines.length, lines: runtime.lines },
    }
  }

  logs(id: string, offset: number): { nextOffset: number; lines: string[] } | undefined {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) return undefined
    const start = Math.max(0, offset - runtime.base)
    return { nextOffset: runtime.base + runtime.lines.length, lines: runtime.lines.slice(start) }
  }

  /** 启动前预检：不拉起实例，只回答"缺什么"。 */
  async check(id: string): Promise<{ id: string; checks: PreflightCheck[] }> {
    const instance = instanceById(this.config, id)
    if (instance === undefined) throw new Error(`没有这个实例：${id}`)
    const runtime = this.runtimeOf(id)
    const hostSelf = this.deps.hostSelf()
    const decision = decideAttach(instance, hostSelf, this.deps.localRuntime())

    // 吸附的实例不启动任何进程，profile / cwd / 入口那一套检查对它没有意义——只回答吸附本身。
    const checks: PreflightCheck[] = decision.attach
      ? [
          {
            name: '吸附宿主自身',
            ok: true,
            detail: `${decision.reason}｜镜像上游 http://127.0.0.1:${String(hostSelf?.port ?? 0)}`,
          },
          {
            name: '启动方式',
            ok: true,
            detail: '不启动新进程：镜像的就是宿主自己那套 DSH（profile / cwd / entry 都不参与）',
          },
        ]
      : await preflight(instance, {
          localRuntime: this.deps.localRuntime,
          dshHome: this.deps.dshHome,
          resolveCredential: this.deps.resolveCredential,
        })
    // 显式写了 attach: true 却吸附不了时要说出来，不能悄悄退回"自己拉一份"。
    if (!decision.attach && instance.kind === 'local' && instance.attach === true) {
      checks.unshift({ name: '吸附宿主自身', ok: false, detail: decision.reason })
    }
    // 顺带把版本探一下：面板因此能在启动前就显示"目标机上装的是哪一版"。
    const probe = await this.probeVersion(instance, runtime)
    if (probe.ok && probe.version !== undefined) runtime.version = probe.version
    checks.push({ name: 'DSH 版本', ok: probe.ok, detail: probe.detail })
    return { id, checks }
  }

  /** 探测某个实例当前的 DSH 版本（不启动实例）。 */
  async version(id: string): Promise<{ id: string; ok: boolean; version?: string; source: string; detail: string }> {
    const instance = instanceById(this.config, id)
    if (instance === undefined) throw new Error(`没有这个实例：${id}`)
    const runtime = this.runtimeOf(id)
    const probe = await this.probeVersion(instance, runtime)
    if (probe.ok && probe.version !== undefined) runtime.version = probe.version
    return {
      id,
      ok: probe.ok,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      source: probe.source,
      detail: probe.detail,
    }
  }

  /**
   * 升级实例上已安装的 DSH 包。
   *
   * 三条硬规矩：实例必须已停止（避免半个进程换版本）；不猜本机实例的安装方式（没配
   * updateCommand 就明说）；桌面版内置运行时（app.asar）拒绝更新并说明该走应用更新。
   */
  async update(id: string, target?: string): Promise<UpdateOutcome> {
    return await this.applyUpdate(id, target ?? 'latest', 'update')
  }

  /** 用最近一次更新记下的旧版本再跑一遍同一条命令。 */
  async rollback(id: string): Promise<UpdateOutcome> {
    const instance = instanceById(this.config, id)
    if (instance === undefined) throw new Error(`没有这个实例：${id}`)
    const runtime = this.runtimeOf(id)
    const previous = runtime.lastUpdate?.from
    if (previous === undefined) throw new Error('没有可回滚的版本记录（先成功更新过一次）')
    return await this.applyUpdate(id, previous, 'rollback')
  }

  private async applyUpdate(
    id: string,
    version: string,
    kind: 'update' | 'rollback',
  ): Promise<UpdateOutcome> {
    const instance = instanceById(this.config, id)
    if (instance === undefined) throw new Error(`没有这个实例：${id}`)
    const runtime = this.runtimeOf(id)
    if (runtime.busy) throw new Error(`实例 ${id} 正在处理上一个操作`)
    if (runtime.phase !== 'stopped') {
      throw new Error(`实例 ${id} 当前是「${runtime.phase}」，请先停止再${kind === 'update' ? '更新' : '回滚'}`)
    }
    if (runtime.attached === true) {
      throw new Error('这个实例吸附的是宿主自身（桌面版内置运行时），它的版本跟着桌面应用走，不能用 npm 更新')
    }

    const plan = resolveUpdatePlan(instance, this.localEntry(instance), version)
    if (!plan.ok || plan.command === undefined) throw new Error(plan.reason ?? '这个实例不支持更新')
    if (kind === 'rollback' && !plan.versioned) {
      throw new Error('updateCommand 里没有 {version} 占位符，无法指定回滚到哪个版本')
    }

    runtime.busy = true
    try {
      const before = await this.probeVersion(instance, runtime)
      if (before.ok && before.version !== undefined) runtime.version = before.version
      const label = kind === 'update' ? '更新' : '回滚'
      this.append(runtime, `${label}：${plan.command}（当前版本 ${before.version ?? '未知'}）`)

      const result = await this.runCommand(instance, runtime, plan.command, UPDATE_TIMEOUT_MS)
      for (const line of tailLines(result.stdout)) this.append(runtime, line)
      for (const line of tailLines(result.stderr)) this.append(runtime, `[stderr] ${line}`)

      const after = await this.probeVersion(instance, runtime)
      const ok = result.code === 0
      const detail =
        result.code === null
          ? `${label}超时，已终止`
          : ok
            ? `${label}命令以 0 退出（版本 ${before.version ?? '未知'} → ${after.version ?? '未知'}）`
            : `${label}命令以 ${String(result.code)} 退出`

      const record: UpdateRecord = {
        from: before.version,
        to: after.version,
        command: plan.command,
        at: Date.now(),
        ok,
        detail,
        kind,
      }
      runtime.lastUpdate = record
      if (after.ok && after.version !== undefined) runtime.version = after.version
      this.append(runtime, `${label}结果：${detail}`)

      return {
        id,
        ok,
        kind,
        command: plan.command,
        before,
        after,
        record,
        rollbackable: after.ok && before.version !== undefined && plan.versioned,
      }
    } finally {
      runtime.busy = false
    }
  }

  /* ── 版本探测与远端命令 ── */

  private localEntry(instance: RemoteDeskInstance): string | undefined {
    if (instance.kind !== 'local') return undefined
    return instance.entry ?? this.deps.localRuntime()?.entry
  }

  private async probeVersion(instance: RemoteDeskInstance, runtime: Runtime): Promise<VersionProbe> {
    if (instance.kind === 'local') {
      const entry = this.localEntry(instance)
      if (entry === undefined) return { ok: false, source: 'local', detail: '找不到本机运行时入口' }
      // <root>/lib/bin.js → <root>/package.json：读文件比起进程更快，也没有副作用。
      const manifest = join(dirname(dirname(entry)), 'package.json')
      try {
        const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { version?: string }
        return parsed.version === undefined
          ? { ok: false, source: manifest, detail: 'package.json 里没有 version 字段' }
          : { ok: true, version: parsed.version, source: manifest, detail: `读到 ${parsed.version}` }
      } catch (error) {
        return { ok: false, source: manifest, detail: describeError(error) }
      }
    }

    const result = await this.runCommand(instance, runtime, 'dsh -V', VERSION_TIMEOUT_MS)
    const text = `${result.stdout}\n${result.stderr}`
    const parsed = parseVersion(text)
    return parsed === undefined
      ? {
          ok: false,
          source: 'dsh -V',
          detail: `没解析出版本（退出码 ${String(result.code)}）：${text.trim().split('\n').slice(-2).join(' / ').slice(0, 140)}`,
        }
      : { ok: true, version: parsed, source: 'dsh -V', detail: `读到 ${parsed}` }
  }

  /** 在实例所在的环境里跑一条 shell 命令，收集输出直到退出（超时则终止）。 */
  private async runCommand(
    instance: RemoteDeskInstance,
    runtime: Runtime,
    command: string,
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (instance.kind === 'ssh') {
      // 实例停止时没有常驻连接，临时开一条，用完即收。
      const owned = runtime.ssh === undefined
      const connection = runtime.ssh ?? this.createSsh(instance, runtime)
      try {
        const stream = await connection.exec(`${POSIX_SHELL_PREFIX}; ${command}`)
        return await this.collect(sshProcessHandle(stream), timeoutMs)
      } finally {
        if (owned) await connection.dispose()
      }
    }

    const subprocess = this.subprocess()
    if (subprocess === undefined) throw new Error('宿主没有提供 subprocess 服务，无法执行命令')
    const argv =
      instance.kind === 'wsl'
        ? wslShellArgv(instance, command)
        : process.platform === 'win32'
          ? ['cmd.exe', '/d', '/s', '/c', command]
          : ['bash', '-lc', command]
    const handle = subprocess.spawn({
      argv,
      cwd: instance.kind === 'local' ? (instance.cwd ?? homedir()) : process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
      graceMs: 5_000,
      env: { ...process.env } as NodeJS.ProcessEnv,
    })
    return await this.collect(handle, timeoutMs)
  }

  /** 把句柄的输出抽干直到它退出；超时就终止，并把这件事写进 stderr。 */
  private async collect(
    handle: SubprocessHandleLike,
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const deadline = Date.now() + timeoutMs
    let outOffset = 0
    let errOffset = 0
    let stdout = ''
    let stderr = ''
    let finished = false
    const settled = handle.done.then(
      () => {
        finished = true
      },
      () => {
        finished = true
      },
    )
    const drain = (): void => {
      const out = handle.collected.stdout?.readFrom(outOffset)
      if (out !== undefined) {
        outOffset = out.nextOffset
        stdout += out.text
      }
      const err = handle.collected.stderr?.readFrom(errOffset)
      if (err !== undefined) {
        errOffset = err.nextOffset
        stderr += err.text
      }
    }
    while (!finished && Date.now() < deadline) {
      drain()
      await delay(200)
    }
    drain()
    if (!finished) {
      handle.terminate()
      await Promise.race([settled, delay(3_000)])
      drain()
      return {
        code: null,
        stdout,
        stderr: `${stderr}\n[超过 ${String(Math.round(timeoutMs / 1000))} 秒未结束，已终止]`,
      }
    }
    await settled
    const outcome = await handle.done.catch(() => ({ exitCode: null, signal: null }))
    return { code: outcome.exitCode, stdout, stderr }
  }

  private createSsh(instance: RemoteDeskInstance, runtime: Runtime): SshConnection {
    return new SshConnection({
      target: {
        host: instance.host ?? '',
        port: instance.port ?? 22,
        username: instance.username ?? '',
        auth: instance.auth ?? { method: 'agent' },
      },
      jumpHosts: instance.jumpHosts,
      resolveCredential: this.deps.resolveCredential,
      log: (message) => this.append(runtime, message),
      ...(instance.hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint: instance.hostKeyFingerprint }),
    })
  }

  async start(id: string): Promise<InstanceSnapshot> {
    const instance = instanceById(this.config, id)
    if (instance === undefined) throw new Error(`没有这个实例：${id}`)
    const runtime = this.runtimeOf(id)
    if (runtime.busy) throw new Error(`实例 ${id} 正在处理上一个操作`)
    if (runtime.phase === 'running') return this.snapshot(id) as InstanceSnapshot
    if (!instance.enabled) throw new Error(`实例 ${id} 已禁用（enabled: false）`)

    // 吸附：宿主自己那套 DSH 已经在跑了，这里不拉进程，只把镜像端点接到它身上。
    const attach = decideAttach(instance, this.deps.hostSelf(), this.deps.localRuntime())
    if (attach.attach) return await this.attachSelf(id, instance, runtime, attach.reason)
    // 显式要求吸附却吸附不了：明说原因，不悄悄退回"自己拉一份"（那会起出第二套 DSH）。
    if (instance.attach === true) throw new Error(`实例 ${id} 要求吸附，但做不到：${attach.reason}`)

    const subprocess = this.subprocess()
    const localTransport = instance.kind !== 'ssh'
    if (localTransport && subprocess === undefined) {
      throw new Error('宿主没有提供 subprocess 服务，无法启动本机 / WSL 实例')
    }

    runtime.busy = true
    this.setPhase(runtime, 'starting', '正在拉起实例')
    runtime.error = undefined
    runtime.exit = undefined
    // 只在本轮新增的日志里找就绪行，避免撞上上一轮遗留的那一条。
    runtime.readyFromGlobal = runtime.base + runtime.lines.length

    try {
      const plan = planFor(instance, this.deps.localRuntime(), this.deps.dshHome)
      let handle: SubprocessHandleLike
      if (plan.transport === 'ssh') {
        this.append(runtime, `启动：${plan.describe}`)
        const ssh = new SshConnection({
          target: {
            host: instance.host ?? '',
            port: instance.port ?? 22,
            username: instance.username ?? '',
            auth: instance.auth ?? { method: 'agent' },
          },
          jumpHosts: instance.jumpHosts,
          resolveCredential: this.deps.resolveCredential,
          log: (message) => this.append(runtime, message),
          ...(instance.hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint: instance.hostKeyFingerprint }),
        })
        runtime.ssh = ssh
        handle = sshProcessHandle(await ssh.exec(plan.command))
      } else {
        const spec = plan.spec
        this.append(runtime, `启动：${spec.describe}`)
        if (subprocess === undefined) throw new Error('宿主没有提供 subprocess 服务')
        handle = subprocess.spawn({
          argv: spec.argv,
          cwd: spec.cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 512 * 1024 }, stderr: { maxBytes: 512 * 1024 } },
          graceMs: 5_000,
          env: spec.env as NodeJS.ProcessEnv,
        })
      }
      runtime.handle = handle

      // done 可能**拒绝**（spawn 本身失败，例如入口文件不存在）。没有第二个回调
      // 就是一个未处理的 Promise 拒绝——实测这类东西足以把宿主带走。
      void handle.done.then(
        (outcome) => {
          runtime.exit = { code: outcome.exitCode, signal: outcome.signal }
          if (runtime.phase === 'stopping' || runtime.phase === 'stopped') return
          if (runtime.phase === 'running' || runtime.phase === 'starting') {
            const reason = `实例进程意外退出（code=${String(outcome.exitCode)} signal=${String(outcome.signal)}）`
            runtime.error = '进程意外退出'
            this.setPhase(runtime, 'error', reason)
            // 写进日志环：面板的日志抽屉要能直接显示原因，而不是只留一堆 stderr。
            this.append(runtime, reason)
            void this.teardownEndpoint(runtime)
          }
        },
        (error: unknown) => {
          const reason = `实例进程启动失败：${describeError(error)}`
          this.append(runtime, reason)
          // 让等就绪行的循环立刻收手，而不是干等到超时。
          runtime.exit = { code: null, signal: null }
          if (runtime.phase === 'starting' || runtime.phase === 'running') {
            runtime.error = reason
            this.setPhase(runtime, 'error', reason)
            void this.teardownEndpoint(runtime)
          }
        },
      )

      this.startLogPump(runtime, handle)
      const readyUrl = await this.awaitReadyUrl(runtime, instance.readyTimeoutMs ?? READY_TIMEOUT_MS)
      if (readyUrl === undefined) {
        const limit = instance.readyTimeoutMs ?? READY_TIMEOUT_MS
        const reason = runtime.error ?? `等待就绪行超时（${String(Math.round(limit / 1000))} 秒）`
        runtime.error = reason
        this.setPhase(runtime, 'error', reason)
        this.stopLogPump(runtime)
        handle.terminate()
        return this.snapshot(id) as InstanceSnapshot
      }

      const remotePort = Number(new URL(readyUrl).port)
      runtime.readyUrl = readyUrl
      runtime.remotePort = remotePort

      const exchanged = await exchangeSession(
        readyUrl,
        runtime.ssh === undefined
          ? {}
          : {
              connect: async () =>
                runtime.ssh === undefined
                  ? await Promise.reject(new Error('SSH 连接已释放'))
                  : asSocket(await runtime.ssh.forwardOut('127.0.0.1', remotePort)),
              remotePort,
            },
      )
      this.append(runtime, `会话换取：${exchanged.detail}`)
      if (!exchanged.ok || exchanged.cookie === undefined) {
        const reason = `实例起来了，但没能换取会话 cookie：${exchanged.detail}`
        runtime.error = reason
        this.setPhase(runtime, 'error', reason)
        this.stopLogPump(runtime)
        handle.terminate()
        return this.snapshot(id) as InstanceSnapshot
      }
      runtime.cookie = exchanged.cookie

      const connector = await this.connectorFor(instance, remotePort, runtime)
      runtime.upstreamDescription = connector.describe()
      const { endpoint, info } = await this.startEndpoint(runtime, instance, remotePort, connector)
      runtime.endpoint = endpoint
      this.setPhase(runtime, 'running', `运行中，远端端口 ${String(remotePort)}`)
      this.append(runtime, `镜像入口 ${info.entryUrl}`)
      // 预热：实例一就绪就把远端那套前端先拉进镜像缓存。远端是按需拼 combo bundle 的
      // （第一次要现读现拼几 MB），不预热的话这份成本就落在用户切过去的那一刻。
      void this.warmMirror(runtime, endpoint, info.port)
      return this.snapshot(id) as InstanceSnapshot
    } catch (error) {
      const reason = describeError(error)
      runtime.error = reason
      this.setPhase(runtime, 'error', reason)
      this.append(runtime, `启动失败：${reason}`)
      this.stopLogPump(runtime)
      runtime.handle?.terminate()
      runtime.handle = undefined
      return this.snapshot(id) as InstanceSnapshot
    } finally {
      runtime.busy = false
    }
  }

  async stop(id: string): Promise<InstanceSnapshot> {
    const instance = instanceById(this.config, id)
    if (instance === undefined) throw new Error(`没有这个实例：${id}`)
    const runtime = this.runtimeOf(id)
    if (runtime.busy) throw new Error(`实例 ${id} 正在处理上一个操作`)

    runtime.busy = true
    this.setPhase(runtime, 'stopping', '正在停止')
    try {
      await this.teardownEndpoint(runtime)
      const handle = runtime.handle
      if (handle !== undefined) {
        handle.terminate()
        const exited = await handle.waitForExit(new AbortController().signal).catch(() => false)
        this.append(runtime, exited ? '实例进程已退出' : '实例进程未在宽限期内退出')
      }
      runtime.handle = undefined
      await runtime.ssh?.dispose()
      runtime.ssh = undefined
      runtime.cookie = undefined
      runtime.readyUrl = undefined
      runtime.remotePort = undefined
      runtime.upstreamDescription = undefined
      runtime.error = undefined
      this.stopLogPump(runtime)
      // 吸附的实例没有自己的进程可停——只有镜像端点收摊，宿主那套 DSH 照旧在跑。
      const detail =
        runtime.attached === true ? '已停止镜像（宿主自身的 DSH 仍在运行，随时可再吸附）' : '已停止'
      this.setPhase(runtime, 'stopped', detail)
      this.append(runtime, detail)
      return this.snapshot(id) as InstanceSnapshot
    } finally {
      runtime.busy = false
    }
  }

  /**
   * 桌面应用打开时，把「本机内置运行」那一条直接置为运行中——它本来就在跑。
   *
   * 返回吸附成功的实例 id；失败只记日志（面板里能看到原因），不阻塞宿主启动。
   */
  async autoAttach(): Promise<string[]> {
    // 宿主自己的能力（web 端口 / 进程令牌 / 前端兜底路由）偶尔比本插件的 apply 稍晚就位。
    // 这里只等"端口 + 令牌"；`/` 路由那条时序由 attachSelf 里的退避重试兜住。
    const mightAttach = this.config.instances.some(
      (instance) => instance.enabled && instance.kind === 'local' && instance.attach !== false,
    )
    if (mightAttach) {
      const deadline = Date.now() + ATTACH_READY_TIMEOUT_MS
      while (this.deps.hostSelf()?.tokenized !== true && Date.now() < deadline) {
        await delay(ATTACH_POLL_MS)
      }
    }

    const attached: string[] = []
    for (const instance of this.config.instances) {
      if (!instance.enabled) continue
      const decision = decideAttach(instance, this.deps.hostSelf(), this.deps.localRuntime())
      if (!decision.attach) continue
      try {
        await this.start(instance.id)
        attached.push(instance.id)
      } catch (error) {
        this.append(this.runtimeOf(instance.id), `自动吸附失败：${describeError(error)}`)
      }
    }
    return attached
  }

  /**
   * 吸附宿主自身：不拉进程，只做两件事——
   * 1. 用宿主自己的进程令牌换一次会话 cookie（就是桌面壳启动时用的那条路）；
   * 2. 起一个镜像端点，把宿主自己的 UI 搬到**独立端口**上（挂在同端口会被桌面 guest 拦掉）。
   *
   * 这里有两处**必须等**的启动时序，都是实测踩出来的：
   * - `connection` 服务可能比本插件的 apply 晚挂上 → 拿不到进程令牌，裸地址换不到 cookie；
   * - 前端静态兜底（`/` 那条路由）在启动期还没注册 → 这时任何未匹配请求都会拿到 404。
   * 所以：先等令牌到位，再换 cookie（换不到就退避重试几轮），而不是一失败就把实例钉成 error。
   */
  private async attachSelf(
    id: string,
    instance: RemoteDeskInstance,
    runtime: Runtime,
    reason: string,
  ): Promise<InstanceSnapshot> {
    runtime.busy = true
    runtime.attached = true
    runtime.error = undefined
    runtime.exit = undefined
    this.setPhase(runtime, 'starting', '正在吸附宿主自身的 DSH')
    this.append(runtime, `吸附：${reason}`)
    try {
      const self = await this.waitForHostSelf(runtime, ATTACH_READY_TIMEOUT_MS)
      if (self === undefined) throw new Error('拿不到宿主自身的 web 端口或进程令牌，无法吸附')
      if (!self.tokenized) {
        this.append(runtime, '宿主还没有给出进程令牌（connection 服务可能尚未挂载），仍按裸地址试一次')
      }
      this.append(runtime, `吸附目标：${maskToken(self.authenticatedUrl)}`)

      const exchanged = await this.exchangeWithRetry(runtime, self)
      this.append(runtime, `会话换取：${exchanged.detail}`)
      if (!exchanged.ok || exchanged.cookie === undefined) {
        throw new Error(`没能用宿主自己的令牌换到会话 cookie（${exchanged.detail}）`)
      }
      runtime.cookie = exchanged.cookie
      runtime.remotePort = self.port

      const connector = tcpUpstream('127.0.0.1', self.port, 'host-self')
      runtime.upstreamDescription = connector.describe()
      const { endpoint, info } = await this.startEndpoint(runtime, instance, self.port, connector)
      runtime.endpoint = endpoint
      this.setPhase(runtime, 'running', `运行中（吸附宿主自身，端口 ${String(self.port)}）`)
      this.append(runtime, `镜像入口 ${info.entryUrl}`)
      // 和普通启动一样预热：吸附的本机那台最该在应用刚起来时就把前端拉进缓存。
      void this.warmMirror(runtime, endpoint, info.port)
      return this.snapshot(id) as InstanceSnapshot
    } catch (error) {
      const message = describeError(error)
      runtime.error = message
      this.setPhase(runtime, 'error', message)
      this.append(runtime, `吸附失败：${message}`)
      await this.teardownEndpoint(runtime).catch(() => undefined)
      return this.snapshot(id) as InstanceSnapshot
    } finally {
      runtime.busy = false
    }
  }

  /**
   * 等宿主自己的能力就位：端口 + 进程令牌。
   *
   * 优先等"令牌也到位"；超时后返回手里已有的那份（可能是裸地址），由调用方决定怎么兜。
   */
  private async waitForHostSelf(runtime: Runtime, timeoutMs: number): Promise<HostSelfEndpoint | undefined> {
    const deadline = Date.now() + timeoutMs
    let last = this.deps.hostSelf()
    while (last?.tokenized !== true && Date.now() < deadline) {
      await delay(ATTACH_POLL_MS)
      last = this.deps.hostSelf() ?? last
    }
    if (last !== undefined && !last.tokenized && Date.now() >= deadline) {
      this.append(runtime, `等了 ${String(Math.round(timeoutMs / 1000))} 秒仍没等到宿主进程令牌`)
    }
    return last
  }

  /**
   * 预热镜像缓存：走一遍镜像自己（带票据），把首页里引用的前端资源都抓一遍。
   *
   * 为什么值得：远端那套前端是**按需组合**的——`plugins/??a,b,c&rev=…` 这种 URL 第一次请求时
   * 远端才现读现拼（几 MB），用户看到的"渲染时间过长"主要就是这一段。实例一就绪就预热，
   * 等用户切过去时这些资源已经在镜像端点的内存缓存里，第一屏几乎是立刻的。
   *
   * 纯尽力而为：失败、超时、时间不够都只写一行日志，绝不影响实例状态。
   */
  private async warmMirror(runtime: Runtime, endpoint: MirrorEndpoint, port: number): Promise<void> {
    const deadline = Date.now() + WARMUP_TIMEOUT_MS
    const cookie = `${TICKET_COOKIE}=${endpoint.ticketValue}`
    const origin = `http://127.0.0.1:${String(port)}`
    try {
      const index = await fetch(`${origin}/`, { headers: { cookie, accept: 'text/html', 'accept-encoding': 'identity' } })
      if (!index.ok) return
      const html = await index.text()
      const urls = new Set<string>()
      for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const value = match[1] ?? ''
        if (value.startsWith('http') || value.startsWith('data:')) continue
        urls.add(value.startsWith('/') ? value : `/${value}`)
      }
      // `__DSH_BOOT__` 里的 bundle 图（`"url":"plugins/??…"`）；HTML 文本里的 `&` 可能是转义的。
      for (const match of html.matchAll(/"url":"([^"]+)"/g)) {
        urls.add(`/${(match[1] ?? '').replace(/&amp;/g, '&')}`)
      }
      const wanted = [...urls].filter((url) => /\.js|\.css|plugins\/|assets\/|chunks\//.test(url))
      if (wanted.length === 0) return
      const started = Date.now()
      let done = 0
      const queue = [...wanted]
      const worker = async (): Promise<void> => {
        for (;;) {
          if (Date.now() > deadline) return
          const next = queue.shift()
          if (next === undefined) return
          try {
            // identity：让预热拿到的字节与浏览器能直接用的那份一致（别让压缩把缓存搞混）。
            const response = await fetch(`${origin}${next}`, {
              headers: { cookie, 'accept-encoding': 'identity' },
            })
            if (response.ok) {
              done += 1
              await response.arrayBuffer()
            }
          } catch {
            /* 尽力而为 */
          }
        }
      }
      await Promise.all(Array.from({ length: WARMUP_CONCURRENCY }, worker))
      this.append(
        runtime,
        `预热：${String(done)}/${String(wanted.length)} 个前端资源已进镜像缓存` +
          `（${String(Math.round((Date.now() - started) / 100) / 10)} 秒，缓存 ${String(Math.round(endpoint.cachedBytes / 1024))} KB）`,
      )
    } catch (error) {
      this.append(runtime, `预热跳过：${describeError(error)}`)
    }
  }

  /** 会话换取：启动早期 `/` 可能还没被前端兜底认领（那时一律 404），所以退避重试几轮。 */
  private async exchangeWithRetry(runtime: Runtime, self: HostSelfEndpoint): Promise<SessionExchange> {    let last: SessionExchange = { ok: false, status: 0, detail: '尚未尝试' }
    for (let attempt = 1; attempt <= ATTACH_EXCHANGE_ATTEMPTS; attempt += 1) {
      last = await exchangeSession(self.authenticatedUrl)
      if (last.ok && last.cookie !== undefined) return last
      if (attempt < ATTACH_EXCHANGE_ATTEMPTS) {
        await delay(ATTACH_POLL_MS * 2)
        // 令牌可能刚刚才到位：每轮都重新探一次，别拿启动早期那个裸地址试到底。
        const fresh = this.deps.hostSelf()
        if (fresh !== undefined && fresh.tokenized && !self.tokenized) {
          self = fresh
          this.append(runtime, `吸附目标更新为：${maskToken(fresh.authenticatedUrl)}`)
        }
      }
    }
    return last
  }

  async restart(id: string): Promise<InstanceSnapshot> {
    await this.stop(id)
    return await this.start(id)
  }

  async dispose(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) {
      try {
        await this.stop(id)
      } catch (error) {
        this.deps.log(`[dsh-remote-desks] 停止实例 ${id} 时出错：${describeError(error)}`)
      }
    }
  }

  /* ── 内部 ── */

  /** 配置里的镜像端口范围，规范化成 [first, last]；[0,0] 表示交给操作系统。 */
  private get portRange(): [number, number] {
    const range = this.config.mirror?.portRange ?? []
    const first = Number(range[0] ?? 0)
    const last = Number(range[1] ?? first)
    const ok = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= 65535
    return [ok(first) ? first : 0, ok(last) ? last : 0]
  }

  private runtimeOf(id: string): Runtime {
    const existing = this.runtimes.get(id)
    if (existing !== undefined) return existing
    const created: Runtime = {
      phase: 'stopped',
      since: Date.now(),
      detail: '未启动',
      lines: [],
      base: 0,
      stdoutOffset: 0,
      stderrOffset: 0,
      stdoutPending: '',
      stderrPending: '',
      readyFromGlobal: 0,
      busy: false,
    }
    this.runtimes.set(id, created)
    return created
  }

  /**
   * 选上游连接方式。
   *
   * - 本机：直连回环端口。
   * - SSH：每条上游连接一条 `direct-tcpip` 通道，远端不用开端口。
   * - WSL：先确认 Windows 能不能直连发行版里绑 127.0.0.1 的端口（镜像网络模式可以，
   *   默认 NAT 不行），不通就给明确诊断，而不是留一个永远连不上的镜像。
   */
  /**
   * 起镜像端点，尊重配置里的 `mirror.portRange`。
   *
   * 依次尝试范围内的端口，全部被占用（或范围是 [0,0]）时退回让操作系统分配——
   * 端口冲突是可预期的，不该让实例起不来。
   */
  private async startEndpoint(
    runtime: Runtime,
    instance: RemoteDeskInstance,
    remotePort: number,
    connector: UpstreamConnector,
  ): Promise<{ endpoint: MirrorEndpoint; info: { port: number; entryUrl: string; baseUrl: string } }> {
    const range = this.portRange
    const candidates: number[] = []
    // 上次用过的端口排在最前：镜像 origin（`http://127.0.0.1:<port>`）就是浏览器缓存的键，
    // 也是镜像里那套 DSH 自己的 localStorage 的键。换端口 = 冷缓存 + 丢掉远端界面的界面偏好，
    // 用户看到的就是"每次切过去都要重新渲染一遍"。所以能复用就复用。
    const sticky = runtime.lastMirrorPort
    if (sticky !== undefined && sticky > 0 && (range[0] === 0 || (sticky >= range[0] && sticky <= range[1]))) {
      candidates.push(sticky)
    }
    if (range[0] > 0) {
      const last = range[1] >= range[0] ? range[1] : range[0]
      for (let port = range[0]; port <= last; port += 1) {
        if (port !== sticky) candidates.push(port)
      }
    }
    candidates.push(0)

    let lastError: unknown
    for (const port of candidates) {
      const endpoint = new MirrorEndpoint({
        instanceId: instance.id,
        remotePort,
        connector,
        cookie: () => runtime.cookie,
        bindHost: this.config.mirror?.host ?? '127.0.0.1',
        port,
        onLog: (message) => this.append(runtime, message),
      })
      try {
        const info = await endpoint.start()
        runtime.lastMirrorPort = info.port
        if (port !== 0 && candidates.length > 1 && port !== sticky) {
          this.append(runtime, `镜像端点使用配置范围内的端口 ${String(port)}`)
        }
        return { endpoint, info }
      } catch (error) {
        lastError = error
        await endpoint.close().catch(() => undefined)
        const code = (error as { code?: string }).code
        if (code !== 'EADDRINUSE') throw error
        if (port !== 0) this.append(runtime, `端口 ${String(port)} 已被占用，试下一个`)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('镜像端点无法监听')
  }

  private async connectorFor(
    instance: RemoteDeskInstance,
    remotePort: number,
    runtime: Runtime,
  ): Promise<UpstreamConnector> {
    if (instance.kind === 'local') return tcpUpstream('127.0.0.1', remotePort, 'local')
    if (instance.kind === 'ssh') {
      const ssh = runtime.ssh
      if (ssh === undefined) throw new Error('SSH 连接不存在，无法建立数据面')
      return sshUpstream(ssh, remotePort)
    }

    const reachable = await probeTcp('127.0.0.1', remotePort)
    this.append(
      runtime,
      reachable
        ? `WSL 回环端口 ${String(remotePort)} 在 Windows 侧可达，直连`
        : `WSL 回环端口 ${String(remotePort)} 在 Windows 侧不可达`,
    )
    if (!reachable) {
      throw new Error(
        `发行版 ${instance.distro ?? '?'} 里绑定的 127.0.0.1:${String(remotePort)} 在 Windows 侧访问不到。` +
          '请在 .wslconfig 里开启镜像网络（networkingMode=mirrored）后重试；中继方案会在后续版本提供。',
      )
    }
    return tcpUpstream('127.0.0.1', remotePort, 'local')
  }

  private async awaitReadyUrl(runtime: Runtime, timeoutMs = READY_TIMEOUT_MS): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS)
      if (runtime.exit !== undefined) return undefined
      // 只看本轮日志：日志环跨轮次保留，上一轮的就绪行仍然躺在里面。
      const start = Math.max(0, runtime.readyFromGlobal - runtime.base)
      const found = findReadyUrl(runtime.lines.slice(start).join('\n'))
      if (found !== undefined) return found
    }
    return undefined
  }

  private startLogPump(runtime: Runtime, handle: SubprocessHandleLike): void {
    const pump = (): void => {
      const stdout = handle.collected.stdout
      if (stdout !== undefined) {
        const read = stdout.readFrom(runtime.stdoutOffset)
        runtime.stdoutOffset = read.nextOffset
        if (read.text !== '') this.pushChunk(runtime, read.text, 'stdout')
      }
      const stderr = handle.collected.stderr
      if (stderr !== undefined) {
        const read = stderr.readFrom(runtime.stderrOffset)
        runtime.stderrOffset = read.nextOffset
        if (read.text !== '') this.pushChunk(runtime, read.text, 'stderr')
      }
    }
    pump()
    runtime.poll = setInterval(pump, POLL_INTERVAL_MS)
    runtime.poll.unref?.()
  }

  private stopLogPump(runtime: Runtime): void {
    if (runtime.poll !== undefined) clearInterval(runtime.poll)
    runtime.poll = undefined
  }

  private pushChunk(runtime: Runtime, chunk: string, stream: 'stdout' | 'stderr'): void {
    const key = stream === 'stdout' ? 'stdoutPending' : 'stderrPending'
    const combined = runtime[key] + chunk
    const parts = combined.split(/\r?\n/)
    runtime[key] = parts.pop() ?? ''
    for (const line of parts) {
      if (line.trim() === '') continue
      this.append(runtime, stream === 'stdout' ? line : `[stderr] ${line}`)
    }
  }

  private append(runtime: Runtime, line: string): void {
    runtime.lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
    if (runtime.lines.length > MAX_LOG_LINES) {
      const drop = runtime.lines.length - MAX_LOG_LINES
      runtime.lines.splice(0, drop)
      runtime.base += drop
    }
  }

  private setPhase(runtime: Runtime, phase: InstancePhase, detail: string): void {
    runtime.phase = phase
    runtime.since = Date.now()
    runtime.detail = detail
  }

  private async teardownEndpoint(runtime: Runtime): Promise<void> {
    const endpoint = runtime.endpoint
    runtime.endpoint = undefined
    if (endpoint !== undefined) await endpoint.close()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** 只取命令输出的尾部若干行，避免 npm 刷屏把日志环冲掉。 */
function tailLines(text: string, limit = UPDATE_LOG_LINES): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-limit)
}

/**
 * 日志里要写"吸附目标是谁"，但**令牌不能进日志**——它是本进程的登录凭据。
 * 这里保留 origin 与路径，只把令牌的值抹掉。
 */
export function maskToken(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|secret|ticket/i.test(key)) parsed.searchParams.set(key, '***')
    }
    return parsed.href
  } catch {
    return url
  }
}

async function probeTcp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host, port })
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import { connect } from 'node:net'

import { MirrorEndpoint } from '../mirror/endpoint.js'
import { asSocket, sshUpstream, tcpUpstream, type UpstreamConnector } from '../mirror/upstream.js'
import type { RemoteDeskInstance } from '../config.js'
import { SshConnection } from '../ssh/manager.js'
import { sshProcessHandle } from '../ssh/process.js'
import { exchangeSession, findReadyUrl } from './readiness.js'
import { preflight, type PreflightCheck } from './preflight.js'
import { planFor } from './spec.js'
import {
  instanceById,
  labelOf,
  type InstanceConfigSource,
  type InstancePhase,
  type InstanceSnapshot,
  type SupervisorDeps,
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
    const checks = await preflight(instance, {
      localRuntime: this.deps.localRuntime,
      dshHome: this.deps.dshHome,
      resolveCredential: this.deps.resolveCredential,
    })
    return { id, checks }
  }

  async start(id: string): Promise<InstanceSnapshot> {
    const instance = instanceById(this.config, id)
    if (instance === undefined) throw new Error(`没有这个实例：${id}`)
    const runtime = this.runtimeOf(id)
    if (runtime.busy) throw new Error(`实例 ${id} 正在处理上一个操作`)
    if (runtime.phase === 'running') return this.snapshot(id) as InstanceSnapshot
    if (!instance.enabled) throw new Error(`实例 ${id} 已禁用（enabled: false）`)

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

      void handle.done.then((outcome) => {
        runtime.exit = { code: outcome.exitCode, signal: outcome.signal }
        if (runtime.phase === 'stopping' || runtime.phase === 'stopped') return
        if (runtime.phase === 'running' || runtime.phase === 'starting') {
          runtime.error = '进程意外退出'
          this.setPhase(
            runtime,
            'error',
            `实例进程意外退出（code=${String(outcome.exitCode)} signal=${String(outcome.signal)}）`,
          )
          void this.teardownEndpoint(runtime)
        }
      })

      this.startLogPump(runtime, handle)
      const readyUrl = await this.awaitReadyUrl(runtime)
      if (readyUrl === undefined) {
        const reason = runtime.error ?? `等待就绪行超时（${String(READY_TIMEOUT_MS / 1000)} 秒）`
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
      const endpoint = new MirrorEndpoint({
        instanceId: instance.id,
        remotePort,
        connector,
        cookie: () => runtime.cookie,
        bindHost: '127.0.0.1',
        port: 0,
        onLog: (message) => this.append(runtime, message),
      })
      const info = await endpoint.start()
      runtime.endpoint = endpoint
      this.setPhase(runtime, 'running', `运行中，远端端口 ${String(remotePort)}`)
      this.append(runtime, `镜像入口 ${info.entryUrl}`)
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
      this.setPhase(runtime, 'stopped', '已停止')
      return this.snapshot(id) as InstanceSnapshot
    } finally {
      runtime.busy = false
    }
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

  private async awaitReadyUrl(runtime: Runtime): Promise<string | undefined> {
    const deadline = Date.now() + READY_TIMEOUT_MS
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

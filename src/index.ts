import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { buildCapabilityReport, probeDshRuntime, type CapabilityReport } from './capabilities.js'
import { Config, type RemoteDesksConfig } from './config.js'
import { createControlHandler, loopbackOriginGuard, type ControlApi } from './control/routes.js'
import { InstanceSupervisor } from './instances/supervisor.js'
import type { HostSelfEndpoint, InstanceSnapshot, LocalRuntime } from './instances/types.js'

/** 插件包名，同时也是客户端 bundle 的模块 id。 */
export const name = 'dsh-remote-desks'
/** 需要的宿主服务：本地 web server（控制接口挂在它上面）。 */
export const inject = ['webServer']
/** 展示名（中文优先）。 */
export const displayName = '远端工作台'
/** 当前里程碑，会出现在面板与状态接口里。 */
export const milestone = 'M5 · 本机吸附（打开即运行中）/ 窗口切换 / 镜像容器稳定'
/** 控制接口挂载前缀。 */
export const CONTROL_PREFIX = '/remote-desks'

export { Config }
export type { RemoteDesksConfig } from './config.js'

const require = createRequire(import.meta.url)

function readOwnVersion(): string {
  try {
    const parsed = require('../package.json') as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const version = readOwnVersion()

/** 宿主上下文里我们用到的部分（结构化声明，避免依赖未随发行版发布 .d.ts 的包）。 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

interface ConnectionLike {
  requestRejection?: (request: unknown) => number | undefined
  /** 给一个普通 web 应用地址加上本进程的令牌（首次登录用）。 */
  authenticatedUrl?: (baseUrl: string) => string
}

interface WebServerLikeWithPort extends WebServerLike {
  /** 真正监听上的端口（监听前是 0）。 */
  port?: number
}

interface LoggerLike {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface RemoteDesksHostContext {
  webServer: WebServerLike
  logger?: LoggerLike
  effect(callback: () => unknown, label?: string): unknown
  get(key: string): unknown
}

/**
 * 组装来源校验：官方信任判定 + 回环校验，两层叠加。
 *
 * 两层都要，理由不同：官方 `connection.requestRejection` 认识 `trustedHosts` 与
 * `Sec-Fetch-Site`，但允许运维显式放行的局域网来源；控制接口能启停进程，所以再叠一层
 * 只认回环的校验。
 *
 * 判定必须在**每个请求**上重做：`connection` 服务在插件 apply 时可能还没挂载，
 * 也可能被替换，apply 时缓存结果会锁死一个错误的档位。
 */
function createGuard(ctx: RemoteDesksHostContext): {
  guard: (req: IncomingMessage) => number | undefined
  describeGate: () => string
} {
  const fallback = loopbackOriginGuard()
  const official = (): ConnectionLike | undefined => {
    const connection = ctx.get('connection') as ConnectionLike | undefined
    return typeof connection?.requestRejection === 'function' ? connection : undefined
  }

  return {
    describeGate: () =>
      official() === undefined
        ? 'loopback-guard'
        : 'connection.requestRejection + loopback-guard',
    guard: (req) => {
      const connection = official()
      if (connection?.requestRejection !== undefined) {
        try {
          const rejection = connection.requestRejection(req)
          if (typeof rejection === 'number') return rejection
        } catch (error) {
          ctx.logger?.warn?.('[dsh-remote-desks] 官方信任判定抛错，改用回环校验：', error)
        }
      }
      return fallback(req)
    },
  }
}

/**
 * 探测「宿主自身」那套 DSH 的端点。
 *
 * 桌面应用打开时，本机那套 DSH 已经在 `127.0.0.1:19387` 上跑着了（就是宿主自己），
 * 所以本机实例的正确行为是**吸附**而不是再拉一份：端口从 `webServer.port` 拿，
 * 会话 cookie 用 `connection.authenticatedUrl()` 加的进程令牌换——桌面壳启动时走的也是这条路。
 *
 * 两个都拿不到时返回 undefined（老宿主），调用方会明说"无法吸附"而不是假装成功。
 */
function probeHostSelf(ctx: RemoteDesksHostContext): HostSelfEndpoint | undefined {
  const server = ctx.get('webServer') as WebServerLikeWithPort | undefined
  const port = typeof server?.port === 'number' && Number.isSafeInteger(server.port) && server.port > 0
    ? server.port
    : undefined
  if (port === undefined) return undefined
  const base = `http://127.0.0.1:${String(port)}/`
  const connection = ctx.get('connection') as ConnectionLike | undefined
  let authenticatedUrl = base
  if (typeof connection?.authenticatedUrl === 'function') {
    try {
      authenticatedUrl = connection.authenticatedUrl(base)
    } catch (error) {
      ctx.logger?.warn?.('[dsh-remote-desks] connection.authenticatedUrl 抛错，改用裸地址：', error)
    }
  }
  return {
    port,
    authenticatedUrl,
    // 裸地址换不到 cookie（会 401），所以这里如实说明"令牌到位了没有"，
    // 由监管器决定是等一等还是直接吸附。
    tokenized: authenticatedUrl.includes('token='),
    describe: `宿主自身（127.0.0.1:${String(port)}）`,
  }
}

/**
 * 插件入口。
 *
 * 装配三件事：宿主能力探测、控制接口（挂在本地 web server 上）、实例监管器。
 * 空配置下不启动任何进程；只有 config.instances 里声明且被 start 的实例才会跑起来——
 * 唯一的例外是「吸附」：本机实例指向的就是宿主自己那套在跑的 DSH，启动时直接接上。
 */
export function apply(ctx: RemoteDesksHostContext, config: RemoteDesksConfig): void {
  const { guard, describeGate } = createGuard(ctx)

  const report = (): CapabilityReport =>
    buildCapabilityReport({
      pluginName: name,
      displayName,
      version,
      milestone,
      controlPrefix: CONTROL_PREFIX,
      gate: describeGate,
      has: (key) => ctx.get(key) !== undefined,
      config,
      webPort: () => probeHostSelf(ctx)?.port,
      selfAttachable: () => probeHostSelf(ctx) !== undefined,
    })

  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const subprocess = (): ReturnType<typeof asSubprocess> => asSubprocess(ctx.get('subprocess'))

  const supervisor = new InstanceSupervisor(
    {
      instances: config.instances,
      mirror: { host: config.mirror.host, portRange: config.mirror.portRange },
    },
    {
      dshHome,
      localRuntime: (): LocalRuntime | undefined => {
        const runtime = probeDshRuntime()
        if (!runtime.found || runtime.entry === undefined) return undefined
        return {
          entry: runtime.entry,
          execPath: process.execPath,
          electron: process.versions.electron !== undefined,
          inAsar: runtime.inAsar === true,
        }
      },
      hostSelf: () => probeHostSelf(ctx),
      resolveCredential: async (name): Promise<string | undefined> => {
        const credentials = ctx.get('credentials') as
          | { resolve(ref: string): Promise<{ value: string } | undefined> }
          | undefined
        if (credentials === undefined || typeof credentials.resolve !== 'function') {
          throw new Error(`宿主没有提供 credentials 服务，无法解析凭据 ${name}`)
        }
        const resolved = await credentials.resolve(name)
        return resolved?.value
      },
      log: (message) => ctx.logger?.info?.(message),
    },
    subprocess,
  )

  ctx.effect(() => () => void supervisor.dispose(), 'dsh-remote-desks: instance supervisor')

  const api: ControlApi = {
    state: () => report(),
    instances: () => supervisor.list(),
    instance: (id) => supervisor.snapshot(id),
    start: (id) => supervisor.start(id),
    stop: (id) => supervisor.stop(id),
    restart: (id) => supervisor.restart(id),
    logs: (id, offset) => supervisor.logs(id, offset),
    check: (id) => supervisor.check(id),
    version: (id) => supervisor.version(id),
    update: (id, target) => supervisor.update(id, target),
    rollback: (id) => supervisor.rollback(id),
  }

  const handler = createControlHandler({ prefix: CONTROL_PREFIX, guard, api })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: CONTROL_PREFIX, handler }),
    'dsh-remote-desks: control routes',
  )

  if (config.announce) {
    const snapshot = report()
    const missing = Object.entries(snapshot.services)
      .filter(([, present]) => !present)
      .map(([key]) => key)
    ctx.logger?.info?.(
      `[${name}] ${displayName} ${version} 已就绪（${milestone}）｜控制接口 ${CONTROL_PREFIX}/api/state` +
        `｜DSH 发行版 ${snapshot.runtime.found ? snapshot.runtime.version ?? '未知' : '未解析到'}` +
        `｜实例 ${String(snapshot.config.instances)} 个（启用 ${String(snapshot.config.enabledInstances)}，自动启动 ${String(snapshot.config.autoStart)}）` +
        `｜缺失服务 ${missing.length === 0 ? '无' : missing.join(', ')}`,
    )
  }

  // 自动启动：不阻塞启动流程，失败只记日志——面板里能看到每个实例的真实状态。
  if (config.autoStart.length > 0) {
    void (async () => {
      for (const id of config.autoStart) {
        try {
          await supervisor.start(id)
        } catch (error) {
          ctx.logger?.warn?.(
            `[${name}] 自动启动实例 ${id} 失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    })()
  }

  // 吸附：本机那一项指向的就是宿主自己那套 DSH，它本来就在跑——启动时直接接上，
  // 免得用户在面板里看到一个"未启动"的本机实例（而它明明正在给他显示这个界面）。
  void (async () => {
    try {
      const attached = await supervisor.autoAttach()
      if (attached.length > 0) {
        ctx.logger?.info?.(
          `[${name}] 已吸附宿主自身：${attached.join(', ')}｜镜像控制接口 ${CONTROL_PREFIX}/api/instances`,
        )
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `[${name}] 自动吸附失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })()
}

/** 从 ctx.get('subprocess') 取出可用的子进程服务；形状不对就当作没有。 */
function asSubprocess(value: unknown): {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
    env?: NodeJS.ProcessEnv
  }): {
    done: Promise<{ exitCode: number | null; signal: string | null }>
    terminate(): void
    waitForExit(signal?: AbortSignal): Promise<boolean>
    collected: {
      stdout?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
      stderr?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
    }
  }
} | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const spawn = (value as { spawn?: unknown }).spawn
  if (typeof spawn !== 'function') return undefined
  return value as never
}

export type { InstanceSnapshot }

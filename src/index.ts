import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { buildCapabilityReport, type CapabilityReport } from './capabilities.js'
import { Config, type RemoteDesksConfig } from './config.js'
import { createControlHandler, loopbackOriginGuard } from './control/routes.js'

/** 插件包名，同时也是客户端 bundle 的模块 id。 */
export const name = 'dsh-remote-desks'
/** 需要的宿主服务：本地 web server（控制接口挂在它上面）。 */
export const inject = ['webServer']
/** 展示名（中文优先）。 */
export const displayName = '远端工作台'
/** 当前里程碑，会出现在面板与状态接口里。 */
export const milestone = 'M0 · 骨架与能力探测'
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
 * 插件入口。
 *
 * M0 只做三件事：探测宿主能力、把控制接口挂到本地 web server、把报告暴露给客户端面板。
 * 不启动任何进程，也不改动任何配置。
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
    })

  const handler = createControlHandler({
    prefix: CONTROL_PREFIX,
    state: () => report(),
    guard,
  })

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
        `｜缺失服务 ${missing.length === 0 ? '无' : missing.join(', ')}`,
    )
  }
}

import type { IncomingMessage, ServerResponse } from 'node:http'

/** 控制接口的挂载前缀（相对本地 DSH web server 的根）。 */
export interface ControlRouteOptions {
  prefix: string
  /** 返回当前状态快照；M0 只提供能力矩阵与实例计数。 */
  state: () => unknown
  /** 返回 401/403 表示拒绝该请求；undefined 表示放行。 */
  guard: (req: IncomingMessage) => number | undefined
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostnameOf(authority: string): string {
  const trimmed = authority.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(0, end + 1)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/**
 * 宿主路由默认不鉴权（`/api` 之外的路由没有内置闸门），所以控制接口必须自带一道。
 *
 * 这道兜底闸门复刻 `/api` 的浏览器信任判定：Host 必须是回环地址；若带了 Origin，
 * 其 Host 必须与请求 Host 一致。桌面外壳转发过来时不会带 Origin（主进程会剥掉），
 * 因此这条规则同时覆盖桌面版与纯 Web 版。
 */
export function loopbackOriginGuard(): (req: IncomingMessage) => number | undefined {
  return (req) => {
    const host = req.headers.host
    if (typeof host !== 'string' || host.length === 0) return 403
    if (!LOOPBACK_HOSTNAMES.has(hostnameOf(host))) return 403

    const origin = req.headers.origin
    if (origin === undefined || origin === 'null') return undefined
    try {
      if (new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
    return undefined
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.end(text)
}

export function createControlHandler(options: ControlRouteOptions) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const rejection = options.guard(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        error: 'rejected',
        reason: '只有来自本机应用自身的请求可以访问这个接口',
      })
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rest = url.pathname.slice(options.prefix.length)
    const route = rest === '' ? '/' : rest

    if (req.method === 'GET' && (route === '/api/state' || route === '/api/state/')) {
      sendJson(res, 200, options.state())
      return
    }

    if (req.method === 'GET' && (route === '/api/ping' || route === '/api/ping/')) {
      sendJson(res, 200, { ok: true, at: new Date().toISOString() })
      return
    }

    sendJson(res, 404, {
      error: 'not-found',
      route,
      hint: 'M0 只提供 /api/state 与 /api/ping；实例管理接口将在 M1 加入。',
    })
  }
}

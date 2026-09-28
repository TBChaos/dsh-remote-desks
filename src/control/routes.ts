import type { IncomingMessage, ServerResponse } from 'node:http'

/** 控制接口对外暴露的操作面；由 index.ts 用监管器实现。 */
export interface ControlApi {
  state(): unknown
  instances(): unknown
  instance(id: string): unknown
  start(id: string): Promise<unknown>
  stop(id: string): Promise<unknown>
  restart(id: string): Promise<unknown>
  logs(id: string, offset: number): unknown
  /** 启动前预检：不拉起实例，只列出缺什么。 */
  check(id: string): Promise<unknown>
}

export interface ControlRouteOptions {
  /** 控制接口的挂载前缀（相对本地 DSH web server 的根）。 */
  prefix: string
  /** 返回 401/403 表示拒绝该请求；undefined 表示放行。 */
  guard: (req: IncomingMessage) => number | undefined
  api: ControlApi
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

/** `/remote-desks` 之后的部分，去掉尾斜杠。 */
function routeOf(pathname: string, prefix: string): string {
  const rest = pathname.slice(prefix.length)
  if (rest === '' || rest === '/') return '/'
  return rest.endsWith('/') ? rest.slice(0, -1) : rest
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
    const route = routeOf(url.pathname, options.prefix)
    const method = req.method ?? 'GET'

    if (method === 'GET' && route === '/api/state') {
      sendJson(res, 200, options.api.state())
      return
    }
    if (method === 'GET' && route === '/api/ping') {
      sendJson(res, 200, { ok: true, at: new Date().toISOString() })
      return
    }
    if (method === 'GET' && route === '/api/instances') {
      sendJson(res, 200, { instances: options.api.instances() })
      return
    }

    const single = /^\/api\/instances\/([^/]+)$/.exec(route)
    if (method === 'GET' && single !== null) {
      const snapshot = options.api.instance(decodeURIComponent(single[1] ?? ''))
      if (snapshot === undefined) {
        sendJson(res, 404, { error: 'not-found', id: single[1] })
        return
      }
      sendJson(res, 200, snapshot)
      return
    }

    const logs = /^\/api\/instances\/([^/]+)\/logs$/.exec(route)
    if (method === 'GET' && logs !== null) {
      const offset = Number(url.searchParams.get('offset') ?? '0')
      const view = options.api.logs(
        decodeURIComponent(logs[1] ?? ''),
        Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
      )
      if (view === undefined) {
        sendJson(res, 404, { error: 'not-found', id: logs[1] })
        return
      }
      sendJson(res, 200, view)
      return
    }

    const checkRoute = /^\/api\/instances\/([^/]+)\/check$/.exec(route)
    if (method === 'GET' && checkRoute !== null) {
      const id = decodeURIComponent(checkRoute[1] ?? '')
      options.api.check(id).then(
        (result) => sendJson(res, 200, result),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          const missing = message.includes('没有这个实例')
          sendJson(res, missing ? 404 : 500, { error: missing ? 'not-found' : 'check-failed', id, message })
        },
      )
      return
    }

    const action = /^\/api\/instances\/([^/]+)\/(start|stop|restart)$/.exec(route)
    if (method === 'POST' && action !== null) {
      const id = decodeURIComponent(action[1] ?? '')
      const name = action[2] as 'start' | 'stop' | 'restart'
      options.api[name](id).then(
        (snapshot) => sendJson(res, 200, snapshot),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          const missing = message.includes('没有这个实例')
          sendJson(res, missing ? 404 : 409, { error: missing ? 'not-found' : 'operation-failed', id, message })
        },
      )
      return
    }

    sendJson(res, 404, {
      error: 'not-found',
      route,
      hint: '可用：GET /api/state、GET /api/instances、GET /api/instances/:id、GET /api/instances/:id/logs、POST /api/instances/:id/{start,stop,restart}',
    })
  }
}

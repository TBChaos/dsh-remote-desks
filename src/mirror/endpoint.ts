import { randomBytes } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'

import { TICKET_COOKIE, rewriteRequestHeaders, rewriteResponseHeaders } from './rewrite.js'
import type { UpstreamConnector } from './upstream.js'

export interface MirrorEndpointOptions {
  instanceId: string
  /** 远端 web 端口；上游 authority 固定为 127.0.0.1:<该端口>。 */
  remotePort: number
  connector: UpstreamConnector
  /** 远端会话 cookie（启动时换好的）。 */
  cookie: () => string | undefined
  bindHost?: string
  port?: number
  onLog?: (message: string) => void
}

export interface MirrorEndpointInfo {
  /** 镜像端点监听端口。 */
  port: number
  /** 首次访问票据；带 `?k=` 打开一次即换成 cookie。 */
  ticket: string
  /** 可直接打开的地址（含票据）。 */
  entryUrl: string
  /** 不带票据的根地址。 */
  baseUrl: string
  upstream: string
}

/**
 * 单个实例的镜像端点。
 *
 * 为什么每个实例单开一个端口，而不是挂在本地 DSH 的 web server 上：
 * 1. 桌面端 Electron guest 明确禁止访问与宿主同端口的回环地址（isApplicationHost），
 *    挂在 19387 上会被直接拦掉；
 * 2. 同源会让远端实例的脚本能拿着你的 cookie 调本地 `/api`（confused deputy），
 *    独立端口天然做掉源隔离。
 *
 * 端点只监听回环，并且除票据 cookie 外一律拒绝。
 */
export class MirrorEndpoint {
  private readonly options: MirrorEndpointOptions
  private readonly ticket = randomBytes(24).toString('base64url')
  private readonly sockets = new Set<Duplex>()
  private server: Server | undefined
  private info: MirrorEndpointInfo | undefined

  constructor(options: MirrorEndpointOptions) {
    this.options = options
  }

  get entryUrl(): string | undefined {
    return this.info?.entryUrl
  }

  get baseUrl(): string | undefined {
    return this.info?.baseUrl
  }

  async start(): Promise<MirrorEndpointInfo> {
    if (this.info !== undefined) return this.info
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.log(`请求处理异常：${describeError(error)}`)
        if (!res.headersSent) failHtml(res, 502, '镜像代理出错', describeError(error))
        else res.destroy()
      })
    })
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head).catch((error: unknown) => {
        this.log(`升级处理异常：${describeError(error)}`)
        socket.destroy()
      })
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })

    const bindHost = this.options.bindHost ?? '127.0.0.1'
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(this.options.port ?? 0, bindHost, () => {
        server.off('error', rejectPromise)
        resolvePromise()
      })
    })

    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('mirror: 无法确定镜像端点端口')
    }
    this.server = server
    const baseUrl = `http://${bindHost}:${String(address.port)}`
    this.info = {
      port: address.port,
      ticket: this.ticket,
      entryUrl: `${baseUrl}/?k=${this.ticket}`,
      baseUrl: `${baseUrl}/`,
      upstream: this.options.connector.describe(),
    }
    this.log(`镜像端点已监听 ${baseUrl}（上游 ${this.info.upstream}）`)
    return this.info
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.info = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server === undefined) return
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise())
      // 有长连接在时 close 不会立即回调，已 destroy 的 socket 会让它尽快落地。
      setTimeout(resolvePromise, 1000).unref?.()
    })
  }

  /* ── 授权与票据 ── */

  private authorized(req: IncomingMessage): boolean {
    const cookie = req.headers.cookie
    if (typeof cookie !== 'string' || cookie === '') return false
    return cookie
      .split(';')
      .map((part) => part.trim())
      .includes(`${TICKET_COOKIE}=${this.ticket}`)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mirror.local')
    const ticket = url.searchParams.get('k')

    if (ticket !== null) {
      if (ticket !== this.ticket) {
        failHtml(res, 403, '票据无效', '这个镜像地址还缺一次带票据的访问。')
        return
      }
      url.searchParams.delete('k')
      const rest = url.searchParams.toString()
      res.statusCode = 302
      res.setHeader('set-cookie', `${TICKET_COOKIE}=${this.ticket}; Path=/; HttpOnly; SameSite=Lax`)
      res.setHeader('location', `${url.pathname}${rest === '' ? '' : `?${rest}`}`)
      res.end()
      return
    }

    if (!this.authorized(req)) {
      failHtml(res, 403, '需要票据', '请从「远端工作台」面板打开这个实例——镜像端点只接受带票据的访问。')
      return
    }

    await this.forward(req, res)
  }

  /* ── HTTP 转发 ── */

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const authority = `127.0.0.1:${String(this.options.remotePort)}`

    let socket: Duplex
    try {
      socket = await this.options.connector.connect(abort.signal)
    } catch (error) {
      const detail = `无法连接远端 ${authority}：${describeError(error)}`
      this.log(detail)
      failHtml(res, 502, '实例暂时连不上', `${detail}。实例可能在启动中或已停止。`)
      return
    }

    const headers = rewriteRequestHeaders(req.headers, authority, this.options.cookie())
    // 不能传 `agent: false`：那等于"使用一个默认 agent"，Node 会忽略 createConnection 去直连。
    // 文档里的原话是 createConnection 生效于 "the agent option is not used"，即完全不传 agent。
    const upstream = httpRequest({
      createConnection: () => socket,
      setHost: false,
      method: req.method,
      path: req.url,
      headers,
    })

    upstream.on('response', (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502
      const rewritten = rewriteResponseHeaders(upstreamRes.headers)
      for (const [name, value] of Object.entries(rewritten)) {
        if (value !== undefined) res.setHeader(name, value)
      }
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      const detail = `上游请求失败 ${req.method ?? 'GET'} ${req.url ?? '/'}：${describeError(error)}`
      this.log(detail)
      if (res.headersSent) {
        res.destroy()
        return
      }
      failHtml(res, 502, '远端响应失败', detail)
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }

  /* ── WebSocket / 升级转发 ── */

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.authorized(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    const authority = `127.0.0.1:${String(this.options.remotePort)}`
    let upstream: Duplex
    try {
      upstream = await this.options.connector.connect()
    } catch (error) {
      this.log(`升级连接上游失败：${describeError(error)}`)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n')
      return
    }

    const headers = rewriteRequestHeaders(req.headers, authority, this.options.cookie(), { websocket: true })
    const lines = [`GET ${req.url ?? '/'} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
      else lines.push(`${name}: ${String(value)}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)

    const teardown = (): void => {
      socket.destroy()
      upstream.destroy()
    }
    socket.on('error', teardown)
    upstream.on('error', teardown)
    socket.on('close', teardown)
    upstream.on('close', teardown)
    socket.pipe(upstream)
    upstream.pipe(socket)
  }

  private log(message: string): void {
    this.options.onLog?.(`[${this.options.instanceId}] ${message}`)
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code
    return code === undefined ? error.message : `${code} ${error.message}`
  }
  return String(error)
}

function failHtml(res: ServerResponse, status: number, title: string, detail: string): void {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb;
font:14px/1.7 system-ui,"Segoe UI",sans-serif}main{max-width:520px;padding:28px 32px;border:1px solid #2a2f3a;border-radius:12px;background:#161a21}
h1{margin:0 0 10px;font-size:16px}p{margin:0;color:#9ca3af;word-break:break-all}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

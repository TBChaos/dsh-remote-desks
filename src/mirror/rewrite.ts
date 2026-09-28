import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

/** 逐跳头，不能透传。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 会挡住内嵌的响应头：远端 UI 要放进 webview/iframe，必须摘掉。 */
const FRAME_BLOCKERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
])

/** 我们自己的票据 cookie 名；转发时必须换掉，不能泄漏给远端。 */
export const TICKET_COOKIE = 'dsh_mirror'

/** 浏览器发给我们的、指向"我们这儿"的头，转发前必须重写。 */
const REWRITTEN_REQUEST_HEADERS = new Set(['host', 'origin', 'referer', 'cookie'])

/**
 * 重写转发给远端的请求头。
 *
 * 三件事必须做对，否则远端 DSH 会拒绝或行为异常：
 * 1. `host` / `origin` 必须改成远端自己的 authority —— 远端的 browser-trust 围栏会核对它们；
 * 2. 注入远端的会话 cookie（我们在实例启动时就换好了）；
 * 3. 摘掉 `sec-fetch-*`：那些值描述的是"浏览器→我们"这一跳，对"我们→远端"没有意义。
 */
export function rewriteRequestHeaders(
  incoming: IncomingHttpHeaders,
  upstreamAuthority: string,
  remoteCookie: string | undefined,
  options: { websocket?: boolean } = {},
): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase()
    if (value === undefined) continue
    if (REWRITTEN_REQUEST_HEADERS.has(lower)) continue
    if (lower.startsWith('sec-fetch-')) continue
    // WebSocket 握手要保留 upgrade/connection，普通请求则逐跳头一律丢掉。
    if (HOP_BY_HOP.has(lower) && !(options.websocket === true && (lower === 'upgrade' || lower === 'connection'))) {
      continue
    }
    outgoing[lower] = value
  }
  outgoing.host = upstreamAuthority
  outgoing.origin = `http://${upstreamAuthority}`
  outgoing.connection = options.websocket === true ? 'Upgrade' : 'close'
  if (remoteCookie !== undefined && remoteCookie !== '') outgoing.cookie = remoteCookie
  return outgoing
}

/**
 * 重写转发给浏览器的响应头。
 *
 * `set-cookie` 必须归一：远端发的是它自己那套 origin 的 cookie，落到我们这套 origin 上时
 * `Domain` 会失效、`Path` 可能不匹配、`Secure` 在 http 回环下会让 cookie 直接丢失。
 */
export function rewriteResponseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase()
    if (value === undefined) continue
    if (HOP_BY_HOP.has(lower) || FRAME_BLOCKERS.has(lower)) continue
    if (lower === 'set-cookie') continue
    outgoing[lower] = value
  }

  const cookies = normalizeSetCookie(incoming['set-cookie'])
  if (cookies.length > 0) outgoing['set-cookie'] = cookies
  return outgoing
}

/** 把远端 cookie 归一成"属于镜像 origin"的形态。 */
export function normalizeSetCookie(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((cookie) => {
    const parts = cookie.split(';')
    const kept: string[] = [parts[0] ?? '']
    for (const rawPart of parts.slice(1)) {
      const part = rawPart.trim()
      const lower = part.toLowerCase()
      if (lower.startsWith('domain=')) continue
      if (lower.startsWith('path=')) continue
      if (lower === 'secure') continue
      if (lower.startsWith('samesite=none')) continue
      kept.push(part)
    }
    kept.push('Path=/')
    return kept.join('; ')
  })
}

/** 从 Set-Cookie 列表里拼出给远端用的 Cookie 头。 */
export function cookieHeaderFrom(setCookie: string | string[] | undefined): string | undefined {
  if (setCookie === undefined) return undefined
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  const pairs = list
    .map((cookie) => (cookie.split(';')[0] ?? '').trim())
    .filter((pair) => pair !== '')
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

/** 上游 authority 永远是远端自己的回环地址——无论我们怎么连过去。 */
export function upstreamAuthority(remotePort: number): string {
  return `127.0.0.1:${String(remotePort)}`
}

/** 把就绪行里的 URL 解析成 { port, token }。 */
export function parseReadyUrl(url: string): { port: number; token: string | undefined } | undefined {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined
    return { port, token: parsed.searchParams.get('token') ?? undefined }
  } catch {
    return undefined
  }
}

/** 从远端 index 里挑出镜像 URL 用的相对路径。 */
export function mirrorPath(pathname: string, ticket: string | undefined): string {
  if (ticket === undefined) return pathname
  const separator = pathname.includes('?') ? '&' : '?'
  return `${pathname}${separator}k=${ticket}`
}

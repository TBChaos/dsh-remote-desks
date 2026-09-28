import { request as httpRequest } from 'node:http'

/** 就绪行：DSH 官方把这一行定义为 supervisor 的就绪信号。 */
const READY_PATTERN = /dsh web:\s*(https?:\/\/\S+)/

export function findReadyUrl(text: string): string | undefined {
  return READY_PATTERN.exec(text)?.[1]
}

export interface SessionExchange {
  ok: boolean
  status: number
  cookie?: string
  location?: string
  detail: string
}

/**
 * 用就绪地址里的 token 换一次会话 cookie。
 *
 * 远端 DSH 的 `/api` 全靠这个签名 cookie 鉴权，而它只认自己的 authority，
 * 所以这次交换必须由我们（而不是浏览器）完成，之后由镜像代理注入。
 */
export function exchangeSession(
  readyUrl: string,
  timeoutMs = 10_000,
): Promise<SessionExchange> {
  return new Promise<SessionExchange>((resolvePromise) => {
    let settled = false
    const finish = (result: SessionExchange): void => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const parsed = new URL(readyUrl)
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { accept: 'text/html' },
      },
      (res) => {
        const setCookie = res.headers['set-cookie']
        const cookie = Array.isArray(setCookie)
          ? setCookie.map((value) => value.split(';')[0]).filter((value) => value !== undefined).join('; ')
          : undefined
        res.resume()
        res.on('end', () => {
          finish({
            ok: res.statusCode === 303 || res.statusCode === 302 || res.statusCode === 200,
            status: res.statusCode ?? 0,
            ...(cookie === undefined || cookie === '' ? {} : { cookie }),
            ...(typeof res.headers.location === 'string' ? { location: res.headers.location } : {}),
            detail:
              cookie === undefined || cookie === ''
                ? `HTTP ${String(res.statusCode ?? 0)}，但没有拿到 Set-Cookie`
                : `HTTP ${String(res.statusCode ?? 0)}，已取得会话 cookie`,
          })
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`换取会话 cookie 超时（${String(timeoutMs)}ms）`))
    })
    req.on('error', (error) => {
      finish({ ok: false, status: 0, detail: error.message })
    })
    req.end()
  })
}

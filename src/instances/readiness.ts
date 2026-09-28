import { request as httpRequest } from 'node:http'
import type { Duplex } from 'node:stream'

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

export interface ExchangeOptions {
  timeoutMs?: number
  /**
   * 自定义传输：SSH 实例的远端回环地址在本地根本连不通，必须走 `forwardOut`。
   * 给了它就只按"远端自己的 authority"发请求（Host 头写 127.0.0.1:<port>）。
   */
  connect?: () => Promise<Duplex>
  /** 远端端口，用于拼 Host 头。 */
  remotePort?: number
}

/**
 * 用就绪地址里的 token 换一次会话 cookie。
 *
 * 远端 DSH 的 `/api` 全靠这个签名 cookie 鉴权，而它只认自己的 authority，
 * 所以这次交换必须由我们（而不是浏览器）完成，之后由镜像代理注入。
 */
export function exchangeSession(
  readyUrl: string,
  options: ExchangeOptions = {},
): Promise<SessionExchange> {
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise<SessionExchange>((resolvePromise) => {
    let settled = false
    const finish = (result: SessionExchange): void => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const parsed = new URL(readyUrl)
    const path = `${parsed.pathname}${parsed.search}`

    const send = (socket?: Duplex): void => {
      const requestOptions =
        socket === undefined
          ? {
              hostname: parsed.hostname,
              port: parsed.port,
              path,
              method: 'GET' as const,
              headers: { accept: 'text/html' },
            }
          : {
              // createConnection 必须**同步**返回 socket，所以隧道要提前开好。
              // 另外不能传 agent：传了 Node 就忽略 createConnection 去直连。
              createConnection: () => socket,
              setHost: false,
              path,
              method: 'GET' as const,
              headers: {
                host: `127.0.0.1:${String(options.remotePort ?? Number(parsed.port))}`,
                accept: 'text/html',
              },
            }
      const req = httpRequest(requestOptions, (res) => {
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
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`换取会话 cookie 超时（${String(timeoutMs)}ms）`))
      })
      req.on('error', (error) => {
        finish({ ok: false, status: 0, detail: error.message })
      })
      req.end()
    }

    if (options.connect === undefined) {
      send()
      return
    }
    options.connect().then(
      (socket) => send(socket),
      (error: unknown) => finish({ ok: false, status: 0, detail: `隧道建立失败：${error instanceof Error ? error.message : String(error)}` }),
    )
  })
}

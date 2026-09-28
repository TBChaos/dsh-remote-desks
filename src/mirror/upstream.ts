import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * 一条指向"远端回环 web 端口"的字节通道。
 *
 * 三种实例的区别全在这里：本机直连、WSL 经中继、SSH 走 forwardOut。镜像代理只认这个接口，
 * 因此 HTTP / WebSocket / SSE 的转发逻辑只有一份。
 */
export interface UpstreamConnector {
  readonly kind: 'local' | 'wsl-relay' | 'ssh-forward'
  /** 给日志和排障用的一句话描述。 */
  describe(): string
  connect(signal?: AbortSignal): Promise<Duplex>
}

/** 直连某个回环端口（本机实例，或 WSL 中继在 Windows 侧的监听）。 */
export function tcpUpstream(
  host: string,
  port: number,
  kind: UpstreamConnector['kind'] = 'local',
): UpstreamConnector {
  return {
    kind,
    describe: () => `${kind} → ${host}:${String(port)}`,
    connect: (signal) =>
      new Promise<Duplex>((resolvePromise, rejectPromise) => {
        const socket: Socket = connect({ host, port })
        const onAbort = (): void => {
          socket.destroy(new Error('mirror: 上游连接被取消'))
        }
        const cleanup = (): void => {
          socket.off('connect', onConnect)
          socket.off('error', onError)
          signal?.removeEventListener('abort', onAbort)
        }
        const onConnect = (): void => {
          cleanup()
          socket.setNoDelay(true)
          resolvePromise(socket)
        }
        const onError = (error: Error): void => {
          cleanup()
          rejectPromise(error)
        }
        socket.once('connect', onConnect)
        socket.once('error', onError)
        if (signal !== undefined) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
  }
}

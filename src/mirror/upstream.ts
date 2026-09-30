import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * 把一条非 TCP 的字节流伪装成 `net.Socket`。
 *
 * Node 的 http 客户端拿到 socket 后会调用 `setTimeout` / `setNoDelay` / `setKeepAlive` 等
 * **只有 net.Socket 才有**的方法；ssh2 的通道只是个 Duplex，直接交给 `http.request` 会以
 * `TypeError: sock.setTimeout is not a function` 崩掉整个进程（实测把宿主带走了）。
 * 这里只补上缺失的那几个，真实的 net.Socket 走这个函数是空操作。
 */
export function asSocket(stream: Duplex): Duplex {
  const shim = stream as Duplex & Record<string, unknown>
  if (typeof shim.setTimeout !== 'function') {
    shim.setTimeout = function setTimeout(this: Duplex, _ms?: number, callback?: () => void) {
      if (typeof callback === 'function') this.once('timeout', callback)
      return this
    }
  }
  if (typeof shim.setNoDelay !== 'function') {
    shim.setNoDelay = function setNoDelay(this: Duplex) {
      return this
    }
  }
  if (typeof shim.setKeepAlive !== 'function') {
    shim.setKeepAlive = function setKeepAlive(this: Duplex) {
      return this
    }
  }
  if (typeof shim.ref !== 'function') {
    shim.ref = function ref(this: Duplex) {
      return this
    }
  }
  if (typeof shim.unref !== 'function') {
    shim.unref = function unref(this: Duplex) {
      return this
    }
  }
  if (typeof shim.address !== 'function') {
    shim.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 0 })
  }
  return shim
}

/**
 * 一条指向"远端回环 web 端口"的字节通道。
 *
 * 三种实例的区别全在这里：本机直连、WSL 经中继、SSH 走 forwardOut。镜像代理只认这个接口，
 * 因此 HTTP / WebSocket / SSE 的转发逻辑只有一份。
 */
export interface UpstreamConnector {
  readonly kind: 'local' | 'host-self' | 'wsl-relay' | 'ssh-forward'
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

/**
 * 经 SSH 隧道连远端回环端口。
 *
 * 这是 SSH 实例与其它两种的**全部区别**：远端不需要暴露端口，也不用建本地端口转发，
 * 每条上游连接就是一条 `direct-tcpip` 通道。
 */
export function sshUpstream(
  connection: { forwardOut(host: string, port: number): Promise<Duplex> },
  remotePort: number,
): UpstreamConnector {
  return {
    kind: 'ssh-forward',
    describe: () => `ssh-forward → 远端 127.0.0.1:${String(remotePort)}`,
    connect: async () => asSocket(await connection.forwardOut('127.0.0.1', remotePort)),
  }
}

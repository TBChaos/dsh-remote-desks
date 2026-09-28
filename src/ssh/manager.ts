import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'

import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'

import type { RemoteDeskAuth, RemoteDeskJumpHost } from '../config.js'

export interface SshEndpoint {
  host: string
  port: number
  username: string
  auth: RemoteDeskAuth
}

export interface SshConnectionOptions {
  /** 最终目标。 */
  target: SshEndpoint
  /** 跳板链，按顺序穿过。 */
  jumpHosts: RemoteDeskJumpHost[]
  /** 按名字解析凭据（走 DSH 凭据库）。 */
  resolveCredential: (name: string) => Promise<string | undefined>
  log: (message: string) => void
  /** 已知主机密钥指纹（SHA256 base64）；留空则接受并打印指纹（TOFU）。 */
  hostKeyFingerprint?: string
  readyTimeoutMs?: number
}

export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/**
 * 一条（可能穿过跳板机的）SSH 连接。
 *
 * 数据面与控制面共用同一条连接：`exec` 起远端进程，`forwardOut` 把远端回环端口搬过来。
 * 这样远端不需要暴露任何端口，也不用在远端防火墙上开口子。
 */
export class SshConnection {
  private readonly options: SshConnectionOptions
  private readonly clients: Client[] = []
  private connecting: Promise<Client> | undefined
  private disposed = false

  constructor(options: SshConnectionOptions) {
    this.options = options
  }

  describe(): string {
    const hops = this.options.jumpHosts.map((hop) => `${hop.username ?? '?'}@${hop.host}:${String(hop.port)}`)
    const chain = hops.length === 0 ? '' : `经 ${hops.join(' → ')} → `
    return `ssh ${chain}${this.options.target.username}@${this.options.target.host}:${String(this.options.target.port)}`
  }

  async ready(): Promise<Client> {
    if (this.disposed) throw new Error('SSH 连接已释放')
    this.connecting ??= this.connectChain()
    return await this.connecting
  }

  async exec(command: string): Promise<ClientChannel> {
    const client = await this.ready()
    return await new Promise<ClientChannel>((resolvePromise, rejectPromise) => {
      client.exec(command, { pty: false }, (error, stream) => {
        if (error) rejectPromise(error)
        else resolvePromise(stream)
      })
    })
  }

  /** 把远端的 host:port 搬成一条本地可用的字节通道。 */
  async forwardOut(host: string, port: number): Promise<Duplex> {
    const client = await this.ready()
    return await new Promise<Duplex>((resolvePromise, rejectPromise) => {
      client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (error) rejectPromise(error)
        else resolvePromise(stream)
      })
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const client of [...this.clients].reverse()) {
      try {
        client.end()
      } catch {
        /* 已经断开 */
      }
    }
    this.clients.length = 0
  }

  /* ── 内部 ── */

  private async connectChain(): Promise<Client> {
    let socket: Duplex | undefined
    const hops = [
      ...this.options.jumpHosts.map((hop) => ({
        host: hop.host,
        port: hop.port,
        username: hop.username ?? this.options.target.username,
        auth: { method: 'agent' } as RemoteDeskAuth,
        privateKeyPath: hop.privateKeyPath,
      })),
      {
        host: this.options.target.host,
        port: this.options.target.port,
        username: this.options.target.username,
        auth: this.options.target.auth,
        privateKeyPath: this.options.target.auth.privateKeyPath,
      },
    ]

    let client: Client | undefined
    for (const [index, hop] of hops.entries()) {
      const isLast = index === hops.length - 1
      const auth = { ...hop.auth }
      if (auth.method === 'agent' && hop.privateKeyPath !== undefined) {
        auth.method = 'privateKey'
        auth.privateKeyPath = hop.privateKeyPath
      }
      client = await this.connectOne(
        {
          host: hop.host,
          port: hop.port,
          username: hop.username,
          auth,
          ...(isLast ? {} : { sock: socket }),
        },
        index === hops.length - 1 ? '目标' : `跳板 ${String(index + 1)}`,
      )
      this.clients.push(client)
      if (!isLast) {
        const next = hops[index + 1]
        if (next === undefined) throw new Error('SSH 跳板链断掉了')
        const hopClient = client
        socket = await new Promise<Duplex>((resolvePromise, rejectPromise) => {
          hopClient.forwardOut('127.0.0.1', 0, next.host, next.port, (error, stream) => {
            if (error) rejectPromise(error)
            else resolvePromise(stream)
          })
        })
      }
    }
    if (client === undefined) throw new Error('SSH 连接链为空')
    return client
  }

  private async connectOne(
    spec: { host: string; port: number; username: string; auth: RemoteDeskAuth; sock?: Duplex },
    label: string,
  ): Promise<Client> {
    const config = await this.connectConfig(spec)
    const client = new Client()
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onReady = (): void => {
        cleanup()
        // ready 之后必须留一个常驻 error 监听：ssh2 的 Client 会在连接异常时 emit 'error'，
        // 没有监听者的 'error' 事件会让 Node 直接终止进程（把宿主一起带走）。
        client.on('error', (error: Error) => {
          this.options.log(`${label} SSH 连接异常：${error.message}`)
        })
        client.on('close', () => {
          this.options.log(`${label} SSH 连接已关闭`)
        })
        this.options.log(`${label} SSH 已连接：${spec.username}@${spec.host}:${String(spec.port)}`)
        resolvePromise()
      }
      const onError = (error: Error): void => {
        cleanup()
        rejectPromise(new Error(`${label} SSH 连接失败（${spec.host}:${String(spec.port)}）：${error.message}`))
      }
      const cleanup = (): void => {
        client.off('ready', onReady)
        client.off('error', onError)
      }
      client.once('ready', onReady)
      client.once('error', onError)
      try {
        client.connect(config)
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return client
  }

  private async connectConfig(spec: {
    host: string
    port: number
    username: string
    auth: RemoteDeskAuth
    sock?: Duplex
  }): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: spec.host,
      port: spec.port,
      username: spec.username,
      readyTimeout: this.options.readyTimeoutMs ?? 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => this.verifyHostKey(key, spec.host),
      ...(spec.sock === undefined ? {} : { sock: spec.sock }),
    }

    if (spec.auth.method === 'privateKey') {
      if (spec.auth.privateKeyPath === undefined || spec.auth.privateKeyPath === '') {
        throw new Error(`SSH 实例配置了 privateKey，但没有 privateKeyPath`)
      }
      config.privateKey = await readFile(spec.auth.privateKeyPath)
      if (spec.auth.passphraseCredential !== undefined) {
        const passphrase = await this.options.resolveCredential(spec.auth.passphraseCredential)
        if (passphrase === undefined) {
          throw new Error(`凭据 ${spec.auth.passphraseCredential} 没有配置（私钥口令）`)
        }
        config.passphrase = passphrase
      }
      return config
    }

    if (spec.auth.method === 'password') {
      if (spec.auth.passwordCredential === undefined) {
        throw new Error('SSH 实例配置了 password，但没有 passwordCredential')
      }
      const password = await this.options.resolveCredential(spec.auth.passwordCredential)
      if (password === undefined) {
        throw new Error(`凭据 ${spec.auth.passwordCredential} 没有配置（登录密码）`)
      }
      config.password = password
      return config
    }

    // agent：优先 SSH_AUTH_SOCK，Windows 退到 OpenSSH 的命名管道
    const agent = process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    if (agent === undefined) throw new Error('auth.method=agent，但环境里没有 SSH_AUTH_SOCK')
    config.agent = agent
    return config
  }

  private verifyHostKey(key: Buffer, host: string): boolean {
    const fingerprint = fingerprintOf(key)
    const pinned = this.options.hostKeyFingerprint
    if (pinned === undefined || pinned === '') {
      this.options.log(`${host} 主机密钥指纹 ${fingerprint}（未固定；如需固定请写进实例配置的 hostKeyFingerprint）`)
      return true
    }
    if (pinned !== fingerprint) {
      this.options.log(`${host} 主机密钥指纹不匹配：期望 ${pinned}，实际 ${fingerprint}`)
      return false
    }
    return true
  }
}

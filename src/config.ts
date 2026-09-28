import Schema from '@deepseek-ai/schemastery'

/** 实例所在的位置。 */
export type InstanceKind = 'local' | 'wsl' | 'ssh'

/** 认证方式；密码/口令只允许通过 DSH 凭据库引用，不写进配置。 */
export type AuthMethod = 'privateKey' | 'password' | 'agent'

export interface RemoteDeskAuth {
  method: AuthMethod
  privateKeyPath?: string
  passphraseCredential?: string
  passwordCredential?: string
}

export interface RemoteDeskJumpHost {
  host: string
  port: number
  username?: string
  privateKeyPath?: string
}

export interface RemoteDeskInstance {
  id: string
  kind: InstanceKind
  label?: string
  enabled: boolean
  /** 实例使用的 DSH profile（不可为 desktop，由桌面应用独占）。 */
  profile?: string
  /** 覆盖 dsh 入口（bin.js 绝对路径）。 */
  entry?: string
  /** 覆盖 node / electron 可执行文件。 */
  nodePath?: string
  /** 实例的工作目录。 */
  cwd?: string
  /** 实例的 DSH_HOME；留空则继承宿主。 */
  dshHome?: string
  /** kind: wsl —— 发行版名与登录用户。 */
  distro?: string
  user?: string
  /** kind: ssh —— 目标主机、端口与登录用户。 */
  host?: string
  port?: number
  username?: string
  auth?: RemoteDeskAuth
  jumpHosts: RemoteDeskJumpHost[]
  /** 已知主机密钥指纹（SHA256 base64）；留空则接受并打印指纹（TOFU）。 */
  hostKeyFingerprint?: string
  /** 覆盖启动命令（留空则按 kind 推导）。 */
  launchCommand?: string
  /** 覆盖更新命令（更新功能尚未启用，先保留字段）。 */
  updateCommand?: string
  /** 等就绪行的上限（毫秒）；慢速远端可以调大。默认 90000。 */
  readyTimeoutMs?: number
}

export type MirrorOpenMode = 'auto' | 'webview' | 'rightbar' | 'iframe' | 'browser'

export interface RemoteDesksConfig {
  instances: RemoteDeskInstance[]
  /** 桌面应用启动时自动拉起的实例 id 列表。 */
  autoStart: string[]
  mirror: {
    /** 只允许回环地址。 */
    host: '127.0.0.1'
    /** 镜像端点监听端口；[0, 0] 表示交给操作系统分配。 */
    portRange: number[]
    openMode: MirrorOpenMode
  }
  /** 是否把就绪信息写进 host 日志。 */
  announce: boolean
}

const Auth = Schema.object({
  // 默认为 agent：ssh 实例不写 auth 时就沿用宿主 SSH agent，避免凭空要求一个必填项。
  method: Schema.union([
    Schema.const('privateKey'),
    Schema.const('password'),
    Schema.const('agent'),
  ]).default('agent'),
  privateKeyPath: Schema.string(),
  passphraseCredential: Schema.string(),
  passwordCredential: Schema.string(),
})

const JumpHost = Schema.object({
  host: Schema.string().required(),
  port: Schema.natural().default(22),
  username: Schema.string(),
  privateKeyPath: Schema.string(),
})

const Instance = Schema.object({
  id: Schema.string().required(),
  kind: Schema.union([
    Schema.const('local'),
    Schema.const('wsl'),
    Schema.const('ssh'),
  ]).required(),
  label: Schema.string(),
  enabled: Schema.boolean().default(true),

  profile: Schema.string(),
  entry: Schema.string(),
  nodePath: Schema.string(),
  cwd: Schema.string(),
  dshHome: Schema.string(),

  distro: Schema.string(),
  user: Schema.string(),

  host: Schema.string(),
  port: Schema.natural(),
  username: Schema.string(),
  auth: Auth,
  jumpHosts: Schema.array(JumpHost).default([]),
  hostKeyFingerprint: Schema.string(),

  launchCommand: Schema.string(),
  updateCommand: Schema.string(),
  readyTimeoutMs: Schema.natural(),
})

export const Config: Schema<RemoteDesksConfig> = Schema.object({
  instances: Schema.array(Instance).default([]),
  autoStart: Schema.array(Schema.string()).default([]),
  mirror: Schema.object({
    host: Schema.const('127.0.0.1').default('127.0.0.1'),
    /** 镜像端点监听端口；[0, 0] 表示交给操作系统分配。 */
    portRange: Schema.array(Schema.natural()).default([0, 0]),
    openMode: Schema.union([
      Schema.const('auto'),
      Schema.const('webview'),
      Schema.const('rightbar'),
      Schema.const('iframe'),
      Schema.const('browser'),
    ]).default('auto'),
  }).default({ host: '127.0.0.1', portRange: [0, 0], openMode: 'auto' }),
  announce: Schema.boolean().default(true),
})

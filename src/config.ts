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
  /**
   * 吸附到**已经在跑**的那套 DSH，而不是自己拉起一个进程。
   *
   * - `true`：显式吸附宿主自身的 web 服务（任何宿主形态都可以）；
   * - `false`：永远自己拉起进程；
   * - 留空（默认）：自动——当宿主就是桌面版内置运行时（`app.asar` 里那份）且本实例没有
   *   指定别的入口时吸附。这正是"打开桌面软件，本机那一项本来就该是运行中"的场景。
   *
   * 吸附时 `profile` / `cwd` / `entry` 都不参与启动（压根没有新进程），镜像的就是宿主自己。
   */
  attach?: boolean
  /** 覆盖启动命令（留空则按 kind 推导）。 */
  launchCommand?: string
  /** 覆盖更新命令（更新功能尚未启用，先保留字段）。 */
  updateCommand?: string
  /** 等就绪行的上限（毫秒）；慢速远端可以调大。默认 90000。 */
  readyTimeoutMs?: number
}

export type MirrorOpenMode = 'auto' | 'webview' | 'rightbar' | 'iframe' | 'browser'

/**
 * 窗口里那个机器切换下拉框的位置。
 *
 * 默认**上边中间**：右上角会压到官方那颗侧栏开关（以及面板自己的按钮），左上角是窗口菜单。
 */
export type SwitcherCorner = 'top-center' | 'top-right' | 'top-left'

export interface RemoteDesksSwitcherConfig {
  /** 是否显示切换下拉框。 */
  enabled: boolean
  /** 贴上边哪个位置。 */
  corner: SwitcherCorner
  /** 距边缘的水平像素（顶部居中时用不上）。默认 56。 */
  offsetX: number
  /**
   * 距顶部的像素。**留空**时跟随官方 token `--dsh-frame-overlay-top`
   * （桌面版 = 标题栏高度 + 20px，全屏时 20px），也就是官方给帧级浮层准备的那条基线。
   */
  offsetY?: number
}

/** 面板的两种形态：统一界面（镜像铺满）与管理界面（列表 + 工具栏 + 日志）。 */
export type WorkbenchLayoutMode = 'immersive' | 'manage'

export interface RemoteDesksLayoutConfig {
  /**
   * 默认形态。
   *
   * `immersive`（默认）= 选中的那台机器的 DSH 界面铺满主区，我们自己的列表 / 工具栏 / 日志都收起来，
   * 只留一条很轻的浮条——目的是"和 WebUI 一样的界面和体验，只是换成另一台机器在跑"。
   * `manage` = 现在这种管理视图。运行时随时可以互相切换（按钮就在面板上，选择记在本地）。
   */
  mode: WorkbenchLayoutMode
  /** 进入统一界面时顺带把官方侧栏收成窄条，让远端 UI 拿到整扇窗（默认否）。 */
  collapseSidebar: boolean
}

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
  /** 全局切换下拉框（窗口角上的「本机 / WSL」）。 */
  switcher: RemoteDesksSwitcherConfig
  /** 面板形态（统一界面 / 管理界面）。 */
  layout: RemoteDesksLayoutConfig
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

  attach: Schema.boolean(),
  launchCommand: Schema.string(),
  updateCommand: Schema.string(),
  readyTimeoutMs: Schema.natural(),
})

const Switcher = Schema.object({
  enabled: Schema.boolean().default(true),
  corner: Schema.union([
    Schema.const('top-center'),
    Schema.const('top-right'),
    Schema.const('top-left'),
  ]).default('top-center'),
  offsetX: Schema.natural().default(56),
  // 不设默认值：留空 = 跟随官方 `--dsh-frame-overlay-top`。
  offsetY: Schema.natural(),
})

const Layout = Schema.object({
  mode: Schema.union([Schema.const('immersive'), Schema.const('manage')]).default('immersive'),
  collapseSidebar: Schema.boolean().default(false),
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
  switcher: Switcher.default({ enabled: true, corner: 'top-center', offsetX: 56 }),
  layout: Layout.default({ mode: 'immersive', collapseSidebar: false }),
  announce: Schema.boolean().default(true),
})

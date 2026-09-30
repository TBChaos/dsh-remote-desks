import type { InstanceKind, RemoteDeskInstance, RemoteDesksConfig } from '../config.js'

/** 实例的生命周期状态。 */
export type InstancePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface InstanceLogView {
  /** 客户端下次该从这个偏移继续读。 */
  nextOffset: number
  lines: string[]
}

/** 一次更新/回滚的记录，面板据此显示「从 X 到 Y」并提供回滚。 */
export interface UpdateRecord {
  from?: string
  to?: string
  command: string
  at: number
  ok: boolean
  detail: string
  kind: 'update' | 'rollback'
}

export interface InstanceSnapshot {
  id: string
  kind: InstanceKind
  label: string
  enabled: boolean
  phase: InstancePhase
  /** 进入当前状态的时间戳（毫秒）。 */
  since: number
  /** 一句话说明当前在做什么或为什么失败。 */
  detail: string
  remotePort?: number
  /** 远端自己的（带 token 的）就绪地址，仅用于排障，不会展示给浏览器。 */
  readyUrl?: string
  /** 镜像端点根地址（不带票据）。 */
  mirrorBaseUrl?: string
  /** 面板里"打开镜像"用的地址（带一次性票据）。 */
  mirrorEntryUrl?: string
  upstream?: string
  error?: string
  exit?: { code: number | null; signal: string | null }
  /** 这个实例是吸附到已在运行的服务（宿主自身），而不是本插件拉起的进程。 */
  attached?: boolean
  /** 已知的 DSH 版本（启动或预检时探测到）。 */
  version?: string
  /** 最近一次更新/回滚记录。 */
  lastUpdate?: UpdateRecord
  logs: InstanceLogView
}

/** 更新 / 回滚的结果（面板直接展示）。 */
export interface UpdateOutcome {
  id: string
  ok: boolean
  kind: 'update' | 'rollback'
  command: string
  before: { ok: boolean; version?: string; source: string; detail: string }
  after: { ok: boolean; version?: string; source: string; detail: string }
  record: UpdateRecord
  /** 有旧版本记录、且命令里带 {version} 时才可以回滚。 */
  rollbackable: boolean
}

export interface LaunchSpec {  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  /** 排障用的一句话描述（不包含凭据）。 */
  describe: string
}

export interface LocalRuntime {
  entry: string
  execPath: string
  electron: boolean
  /** 这份发行版在桌面版的 app.asar 里（即"内置运行时"，无法被单独更新）。 */
  inAsar?: boolean
}

/**
 * 宿主自身那一套 DSH 的端点。
 *
 * 「本机内置运行」指的就是它：桌面应用打开时，这套 DSH 已经在跑了，本插件不该再拉起一份。
 */
export interface HostSelfEndpoint {
  /** 宿主自己的 web 端口。 */
  port: number
  /** 带进程令牌的入口地址，用来换一次会话 cookie（就是桌面壳自己启动时用的那条路）。 */
  authenticatedUrl: string
  /**
   * 这个地址里是否真的带上了进程令牌。
   *
   * 启动早期 `connection` 服务可能还没挂上，此时只能拿到裸地址——而裸地址换不到 cookie，
   * 所以吸附要等它变成 true（详见 InstanceSupervisor 里的等待与重试）。
   */
  tokenized: boolean
  /** 排障用的一句话描述。 */
  describe: string
}

export interface SupervisorDeps {
  /** 解析本机 DSH 发行版入口；拿不到就无法拉起本机实例。 */
  localRuntime: () => LocalRuntime | undefined
  /** 宿主自身的端点；拿不到就无法吸附。 */
  hostSelf: () => HostSelfEndpoint | undefined
  /** DSH_HOME，用于放置自动创建的 profile。 */
  dshHome: string
  /** 按名字解析凭据（SSH 密码 / 私钥口令），走 DSH 凭据库。 */
  resolveCredential: (name: string) => Promise<string | undefined>
  /** 写一行日志到宿主日志。 */
  log: (message: string) => void
}

export type SupervisorConfig = RemoteDesksConfig

/** 只关心实例列表与镜像设置的最小配置视图，便于测试与复用。 */
export interface InstanceConfigSource {
  instances: RemoteDeskInstance[]
  mirror?: { host?: string; portRange: number[] }
}

export function instanceById(
  config: InstanceConfigSource,
  id: string,
): RemoteDeskInstance | undefined {
  return config.instances.find((instance) => instance.id === id)
}

export function labelOf(instance: RemoteDeskInstance): string {
  return instance.label ?? instance.id
}

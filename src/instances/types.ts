import type { InstanceKind, RemoteDeskInstance, RemoteDesksConfig } from '../config.js'

/** 实例的生命周期状态。 */
export type InstancePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface InstanceLogView {
  /** 客户端下次该从这个偏移继续读。 */
  nextOffset: number
  lines: string[]
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
  logs: InstanceLogView
}

export interface LaunchSpec {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  /** 排障用的一句话描述（不包含凭据）。 */
  describe: string
}

export interface LocalRuntime {
  entry: string
  execPath: string
  electron: boolean
}

export interface SupervisorDeps {
  /** 解析本机 DSH 发行版入口；拿不到就无法拉起本机实例。 */
  localRuntime: () => LocalRuntime | undefined
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
  mirror?: { portRange: number[] }
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

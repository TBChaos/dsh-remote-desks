import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * 客户端共享状态：实例列表 + 宿主能力 + 当前选中的实例。
 *
 * 为什么要有这一层：窗口角上那个「本机 / WSL」下拉框和面板里的实例列表看的是同一份数据，
 * 也必须**选中同一件事**。各拉各的会变成两个轮询、两份真相，切换器选了 WSL 而面板还停在
 * 本机——那正是这个功能最容易出的岔子。
 *
 * 所以：一个轮询（有订阅者时才跑），一个选中项，两处 UI 都从这里读。
 */

export const CONTROL_PREFIX = '/remote-desks'
export const STATE_URL = `${CONTROL_PREFIX}/api/state`
export const INSTANCES_URL = `${CONTROL_PREFIX}/api/instances`
export const POLL_INTERVAL_MS = 2000

/* ── 控制接口的数据形状 ── */

export interface UpdateRecordView {
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
  kind: 'local' | 'wsl' | 'ssh'
  label: string
  enabled: boolean
  phase: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  detail: string
  remotePort?: number
  mirrorBaseUrl?: string
  mirrorEntryUrl?: string
  upstream?: string
  error?: string
  /** 吸附到宿主自身（本机内置运行），而不是本插件拉起的进程。 */
  attached?: boolean
  /** 已知的 DSH 版本（启动或预检时探测）。 */
  version?: string
  /** 最近一次更新/回滚。 */
  lastUpdate?: UpdateRecordView
  logs: { nextOffset: number; lines: string[] }
}

export interface HostReport {
  plugin: { name: string; displayName: string; version: string; milestone: string }
  host: {
    platform: string
    arch: string
    node: string
    electron: string | null
    execPath: string
    dshHome: string | null
    dshProfile: string | null
    webPort?: number | null
    selfAttachable?: boolean
  }
  services: Record<string, boolean>
  runtime: {
    found: boolean
    version?: string
    root?: string
    entry?: string
    inAsar?: boolean
    via?: string
    attempts: { via: string; ok: boolean; detail: string }[]
  }
  control: { prefix: string; gate: string }
  config: {
    instances: number
    enabledInstances: number
    autoStart: number
    openMode: string
    attachInstances?: number
    switcher?: string
    layout?: { mode?: LayoutMode; collapseSidebar?: boolean }
  }
}

export type FetchState<T> =
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string }

/** 面板形态：统一界面（镜像铺满） / 管理界面（列表 + 工具栏 + 日志）。 */
export type LayoutMode = 'immersive' | 'manage'

export interface WorkbenchStore {
  /** 宿主能力矩阵（面板据此选容器、切换器据此定位）。 */
  host: FetchState<HostReport>
  /** 实例列表。 */
  instances: FetchState<InstanceSnapshot[]>
  /** 当前选中的实例 id；面板与窗口角的切换器共用。 */
  selected?: string
  /** 用户点过形态按钮之后的覆盖值；没点过就用配置里的默认。 */
  layoutOverride?: LayoutMode
}

/* ── store 本体 ── */

const LAYOUT_KEY = 'dsh-remote-desks:layout-mode'

function readStoredLayout(): LayoutMode | undefined {
  try {
    const value = globalThis.localStorage?.getItem(LAYOUT_KEY)
    return value === 'immersive' || value === 'manage' ? value : undefined
  } catch {
    return undefined
  }
}

const storedLayout = readStoredLayout()
const INITIAL: WorkbenchStore = {
  host: { phase: 'loading' },
  instances: { phase: 'loading' },
  ...(storedLayout === undefined ? {} : { layoutOverride: storedLayout }),
}

let state: WorkbenchStore = INITIAL
const listeners = new Set<() => void>()

function emit(patch: Partial<WorkbenchStore>): void {
  state = { ...state, ...patch }
  for (const listener of [...listeners]) listener()
}

/** 读当前快照（useSyncExternalStore 的 getSnapshot / getServerSnapshot）。 */
export function getWorkbenchStore(): WorkbenchStore {
  return state
}

export function subscribeWorkbench(listener: () => void): () => void {
  listeners.add(listener)
  startPolling()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopPolling()
  }
}

/** 组件里读共享状态。SSR 下走 getServerSnapshot，因此空转也安全。 */
export function useWorkbenchStore(): WorkbenchStore {
  return useSyncExternalStore(subscribeWorkbench, getWorkbenchStore, getWorkbenchStore)
}

let timer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<void> | undefined

/**
 * 轮询节奏：状态在变（有人正在启动/停止）时快一点，平稳时慢一点，页面不可见时不发请求。
 *
 * 切换器常驻在窗口角上，所以这个轮询在应用开着的时候一直在跑——没必要为了一个本地 JSON
 * 每秒敲两次门，但点完「启动」也得马上看到状态点变黄。
 */
function pollDelay(): number {
  const list = state.instances.phase === 'ready' ? state.instances.value : []
  const transitioning = list.some((instance) => instance.phase === 'starting' || instance.phase === 'stopping')
  if (transitioning) return 1000
  return list.some((instance) => instance.phase === 'running') ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 2
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function startPolling(): void {
  if (timer !== undefined) return
  void refreshWorkbench()
  const tick = (): void => {
    timer = setTimeout(() => {
      if (!hidden()) void refreshWorkbench()
      if (listeners.size > 0) tick()
      else timer = undefined
    }, pollDelay())
    ;(timer as { unref?: () => void }).unref?.()
  }
  tick()
}

function stopPolling(): void {
  if (timer === undefined) return
  clearTimeout(timer)
  timer = undefined
}

/** 拉一次实例列表与宿主能力；并发调用合并成一次。 */
export function refreshWorkbench(): Promise<void> {
  if (inflight !== undefined) return inflight
  inflight = (async () => {
    try {
      const [instances, host] = await Promise.all([fetchInstances(), fetchHost()])
      emit({ instances, host })
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

async function fetchInstances(): Promise<FetchState<InstanceSnapshot[]>> {
  try {
    const response = await fetch(INSTANCES_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const body = (await response.json()) as { instances?: InstanceSnapshot[] }
    return { phase: 'ready', value: body.instances ?? [] }
  } catch (error) {
    return { phase: 'error', message: describe(error) }
  }
}

async function fetchHost(): Promise<FetchState<HostReport>> {
  try {
    const response = await fetch(STATE_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return { phase: 'ready', value: (await response.json()) as HostReport }
  } catch (error) {
    return { phase: 'error', message: describe(error) }
  }
}

/** 面板 / 切换器 / 设置页共用的「重新探测」。 */
export function reloadHost(): void {
  void refreshWorkbench()
}

/* ── 选中项 ── */

export function selectInstance(id: string | undefined): void {
  if (state.selected === id) return
  emit({ selected: id })
}

/** 当前应显示的实例：先看选中项，再退回第一个。 */
export function activeInstance(store: WorkbenchStore): InstanceSnapshot | undefined {
  const list = store.instances.phase === 'ready' ? store.instances.value : []
  return list.find((instance) => instance.id === store.selected) ?? list[0]
}

/* ── 面板形态 ── */

/**
 * 当前该用哪种形态：用户点过就以他的为准（记在本地），否则用配置里的默认。
 *
 * 默认是 `immersive`：远端那套 DSH 自己的界面铺满主区——"一样的 UI、一样的体验，
 * 只是换成另一台机器在跑"，这才是这个插件想做的事；管理视图是随时可回的备用形态。
 */
export function layoutModeOf(store: WorkbenchStore): LayoutMode {
  if (store.layoutOverride !== undefined) return store.layoutOverride
  const configured = store.host.phase === 'ready' ? store.host.value.config.layout?.mode : undefined
  return configured === 'manage' ? 'manage' : 'immersive'
}

export function setLayoutMode(mode: LayoutMode): void {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, mode)
  } catch {
    /* 隐私模式 / 无 localStorage：本次会话内照样生效 */
  }
  emit({ layoutOverride: mode })
}

/** 进统一界面时要不要顺手把官方侧栏收成窄条（配置项）。 */
export function collapseSidebarPreferred(store: WorkbenchStore): boolean {
  return store.host.phase === 'ready' && store.host.value.config.layout?.collapseSidebar === true
}

/* ── 下拉框 / 浮条上的短标签 ── */

/** 实例类型 → 一个词。虚拟机走的就是 ssh / wsl，所以标签由用户自己起。 */
export function kindText(kind: InstanceSnapshot['kind']): string {
  return kind === 'local' ? '本机' : kind === 'wsl' ? 'WSL' : 'SSH'
}

/**
 * 下拉框里的关键字。
 *
 * 规则：先去掉 label 里的括注（"本机（内置运行时）" → "本机"），再去掉类型前缀重复，
 * 最后在缺类型词时补上——用户说"字太多，只保留关键字"，那就只留关键字，长说明进 title。
 */
export function shortLabel(instance: InstanceSnapshot): string {
  const kind = kindText(instance.kind)
  const stripped = (instance.label ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s*[·|—-]\s*$/, '')
    .trim()
  const base = stripped === '' ? instance.id : stripped
  return base.startsWith(kind) || base.includes(kind) ? base : `${kind} · ${base}`
}

/** 状态点旁边那两三个字。完整说明（端口、吸附、错误原因）走 title。 */
export function shortStatus(instance: InstanceSnapshot | undefined): string {
  if (instance === undefined) return '未配置'
  if (instance.phase === 'running') return instance.attached === true ? '已连接' : '运行中'
  if (instance.phase === 'starting') return '启动中'
  if (instance.phase === 'stopping') return '停止中'
  if (instance.phase === 'error') return '出错'
  return '未启动'
}

/** 悬停时的完整说明：把关键字省掉的信息补回来。 */
export function longStatus(instance: InstanceSnapshot): string {
  return `${instance.label}｜${instance.detail}` + (instance.error === undefined ? '' : `｜${instance.error}`)
}

/* ── 动作 ── */

export interface ActionResult {
  ok: boolean
  message?: string
  snapshot?: InstanceSnapshot
}

async function postAction(id: string, action: string, body?: unknown): Promise<ActionResult> {
  try {
    const response = await fetch(`${INSTANCES_URL}/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const parsed = (await response.json().catch(() => ({}))) as { message?: string }
    if (!response.ok) return { ok: false, message: parsed.message ?? `HTTP ${response.status}` }
    return { ok: true, snapshot: parsed as unknown as InstanceSnapshot }
  } catch (error) {
    return { ok: false, message: describe(error) }
  } finally {
    await refreshWorkbench()
  }
}

export async function lifecycleAction(
  id: string,
  action: 'start' | 'stop' | 'restart',
): Promise<ActionResult> {
  return await postAction(id, action)
}

/** 更新 / 回滚：body 里带目标版本（省略即 latest）。 */
export async function versionAction(
  id: string,
  action: 'update' | 'rollback',
  target?: string,
): Promise<ActionResult> {
  return await postAction(id, action, target === undefined ? {} : { target })
}

/**
 * 「确保这个实例在跑」——切换器选中某一项时用。
 *
 * 已经在跑就直接返回（控制接口的 start 是幂等的）；吸附的实例在这一步接上宿主自己那套 DSH。
 */
export async function ensureRunning(id: string): Promise<ActionResult> {
  const list = state.instances.phase === 'ready' ? state.instances.value : []
  const instance = list.find((entry) => entry.id === id)
  if (instance !== undefined && instance.phase === 'running') return { ok: true }
  if (instance !== undefined && (instance.phase === 'starting' || instance.phase === 'stopping')) {
    return { ok: true }
  }
  return await postAction(id, 'start')
}

/** 预检：不启动实例，只列出缺什么（用户点按钮才走这里）。 */
export async function checkInstance(id: string): Promise<{ ok: boolean; checks: PreflightItem[]; message?: string }> {
  try {
    const response = await fetch(`${INSTANCES_URL}/${encodeURIComponent(id)}/check`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { checks?: PreflightItem[] }
    return { ok: true, checks: body.checks ?? [] }
  } catch (error) {
    return { ok: false, checks: [], message: describe(error) }
  }
}

export interface PreflightItem {
  name: string
  ok: boolean
  detail: string
}

/** 增量拉某个实例的日志；offset 从 0 开始，之后只取新增部分。 */
export function useInstanceLogs(id: string | undefined, enabled: boolean): { lines: string[]; clear: () => void } {
  const [lines, setLines] = useState<string[]>([])
  const offsetRef = useRef(0)

  useEffect(() => {
    offsetRef.current = 0
    setLines([])
    if (id === undefined || !enabled) return
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(
          `${INSTANCES_URL}/${encodeURIComponent(id)}/logs?offset=${String(offsetRef.current)}`,
          { headers: { accept: 'application/json' } },
        )
        if (!response.ok) return
        const body = (await response.json()) as { nextOffset?: number; lines?: string[] }
        if (!alive) return
        offsetRef.current = body.nextOffset ?? offsetRef.current
        const fresh = body.lines ?? []
        if (fresh.length > 0) setLines((current) => [...current, ...fresh].slice(-400))
      } catch {
        /* 下一轮再试 */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id, enabled])

  return { lines, clear: useCallback(() => setLines([]), []) }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

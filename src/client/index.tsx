import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/** 与 host 半共享的面板 id：sidebar 入口与 main 面板用同一个值。 */
export const PANEL_ID = 'remote-desks'
/** 控制接口前缀，与 host 半的 CONTROL_PREFIX 保持一致。 */
export const CONTROL_PREFIX = '/remote-desks'
/** 展示名（中文优先）。 */
export const DISPLAY_NAME = '远端工作台'

const STYLE_MARKER = 'dsh-remote-desks/client.css'
const POLL_INTERVAL_MS = 2000

/* ── 宿主注入的最小契约（结构化声明，不依赖未随发行版发布的客户端类型） ── */

interface SlotRegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: () => string
  locale?: string
  inject?: () => unknown
  children?: Record<string, { kind: string; scope: string }>
}

interface SlotsService {
  inject(key: string, callback: () => unknown): () => void
  register(options: SlotRegisterOptions, component: (props: never) => ReactNode): () => void
}

interface RightbarService {
  openTab(kind: string, options?: { params?: Record<string, unknown> }): unknown
}

interface LayoutService {
  selectPanel(panelId: string | null): void
  openRightbar(track: boolean, fullscreen: boolean): void
}

interface ClientContext {
  slots: SlotsService
  get?(key: string): unknown
  layout?: LayoutService
  sidebarRight?: RightbarService
}

/** 面板拿到的宿主服务（由 slot 的 inject 注入）。 */
interface PanelServices {
  layout?: LayoutService
  rightbar?: RightbarService
}

interface HostReport {
  plugin: { name: string; displayName: string; version: string; milestone: string }
  host: {
    platform: string
    arch: string
    node: string
    electron: string | null
    execPath: string
    dshHome: string | null
    dshProfile: string | null
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
  config: { instances: number; enabledInstances: number; autoStart: number; openMode: string }
}

interface InstanceSnapshot {
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
  logs: { nextOffset: number; lines: string[] }
}

/* ── 样式：只注入一次，使用官方主题 token，不写死颜色 ── */

const CSS = `
.drd-root { height: 100%; min-height: 0; display: flex; flex-direction: column;
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-base, transparent); font-size: 14px; }
.drd-bar { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, currentColor); }
.drd-title { font-size: 16px; font-weight: 600; margin: 0; }
.drd-badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, currentColor); color: var(--dsw-alias-label-secondary, inherit); }
.drd-spacer { margin-left: auto; }
.drd-btn { font: inherit; font-size: 13px; padding: 3px 12px; border-radius: 8px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, transparent); border: 1px solid var(--dsw-alias-border-l1, currentColor); }
.drd-btn:hover { border-color: var(--dsw-alias-border-l2, currentColor); }
.drd-btn:disabled { opacity: .45; cursor: default; }
.drd-btn[data-primary="true"] { border-color: var(--dsw-alias-brand-primary, currentColor); }
.drd-body { flex: 1; min-height: 0; display: flex; }
.drd-list { width: 232px; flex: none; overflow: auto; border-right: 1px solid var(--dsw-alias-border-l1, currentColor); padding: 10px; }
.drd-item { width: 100%; text-align: left; font: inherit; cursor: pointer; display: block; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: inherit; margin-bottom: 4px; }
.drd-item:hover { background: var(--dsw-alias-bg-layer-1, transparent); }
.drd-item[data-active="true"] { background: var(--dsw-alias-bg-layer-2, transparent); border-color: var(--dsw-alias-border-l1, currentColor); }
.drd-item-top { display: flex; align-items: center; gap: 8px; }
.drd-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary, currentColor); }
.drd-dot[data-phase="running"] { background: var(--dsw-alias-state-success-primary, currentColor); }
.drd-dot[data-phase="starting"], .drd-dot[data-phase="stopping"] { background: var(--dsw-alias-state-warn-primary, currentColor); }
.drd-dot[data-phase="error"] { background: var(--dsw-alias-state-error-primary, currentColor); }
.drd-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drd-meta { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin-top: 2px; }
.drd-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.drd-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, currentColor); flex-wrap: wrap; }
.drd-stage { flex: 1; min-height: 0; position: relative; background: var(--dsw-alias-bg-layer-1, transparent); }
.drd-frame { width: 100%; height: 100%; border: 0; display: block; }
.drd-placeholder { height: 100%; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: var(--dsw-alias-label-secondary, inherit); }
.drd-card { border: 1px solid var(--dsw-alias-border-l1, currentColor); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); padding: 14px 16px; margin: 14px 18px; }
.drd-card h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.drd-grid { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 16px; }
.drd-key { color: var(--dsw-alias-label-secondary, inherit); }
.drd-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.drd-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.drd-chip { font-size: 12px; padding: 1px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, currentColor); }
.drd-chip[data-on="true"] { color: var(--dsw-alias-state-success-primary, inherit); }
.drd-chip[data-on="false"] { color: var(--dsw-alias-state-idle-primary, inherit); }
.drd-logs { max-height: 168px; overflow: auto; margin: 0; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1, currentColor); background: var(--dsw-alias-bg-layer-2, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; }
.drd-error { margin: 10px 16px; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary, currentColor); color: var(--dsw-alias-state-error-primary, inherit); }
.drd-scroll { overflow: auto; height: 100%; }
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_MARKER}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-remote-desks'
  style.dataset.pluginCss = STYLE_MARKER
  style.textContent = CSS
  document.head.appendChild(style)
}

/* ── 控制接口调用 ── */

const STATE_URL = `${CONTROL_PREFIX}/api/state`
const INSTANCES_URL = `${CONTROL_PREFIX}/api/instances`

type FetchState<T> = { phase: 'loading' } | { phase: 'ready'; value: T } | { phase: 'error'; message: string }

function useHostReport(): { state: FetchState<HostReport>; reload: () => void } {
  const [state, setState] = useState<FetchState<HostReport>>({ phase: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setState({ phase: 'loading' })
    fetch(STATE_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        return (await response.json()) as HostReport
      })
      .then((value) => {
        if (alive) setState({ phase: 'ready', value })
      })
      .catch((error: unknown) => {
        if (!alive || controller.signal.aborted) return
        setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [nonce])

  return { state, reload: useCallback(() => setNonce((value) => value + 1), []) }
}

/** 轮询实例列表；启停操作后立刻刷新一次，避免等一个轮询周期。 */
function useInstances(): { instances: InstanceSnapshot[]; error?: string; refresh: () => Promise<void>; act: (id: string, action: 'start' | 'stop' | 'restart') => Promise<void> } {
  const [instances, setInstances] = useState<InstanceSnapshot[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const response = await fetch(INSTANCES_URL, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { instances?: InstanceSnapshot[] }
      setInstances(body.instances ?? [])
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    let alive = true
    const tick = (): void => {
      if (alive) void load()
    }
    tick()
    const timer = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [load])

  const act = useCallback(
    async (id: string, action: 'start' | 'stop' | 'restart') => {
      try {
        const response = await fetch(`${INSTANCES_URL}/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string }
          setError(body.message ?? `HTTP ${response.status}`)
        } else {
          setError(undefined)
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
      await load()
    },
    [load],
  )

  return { instances, ...(error === undefined ? {} : { error }), refresh: load, act }
}

/** 增量拉某个实例的日志；offset 从 0 开始，之后只取新增部分。 */
function useInstanceLogs(id: string | undefined, enabled: boolean): { lines: string[]; clear: () => void } {
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

/* ── 镜像容器：桌面走官方 webview lease，其余降级 ── */

type CarrierMode = 'pending' | 'webview' | 'iframe' | 'failed' | 'external' | 'rightbar'

/** 镜像容器的偏好，来自配置 `mirror.openMode`。 */
type CarrierPreference = 'auto' | 'webview' | 'iframe' | 'browser' | 'rightbar'

interface DesktopBridge {
  browser?: {
    acquire?: (workspace: string) => Promise<{ lease: string; partition: string }>
    release?: (lease: string) => Promise<void>
  }
}

function MirrorStage({
  entryUrl,
  label,
  preference,
  services,
}: {
  entryUrl: string
  label: string
  preference: CarrierPreference
  services: PanelServices
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [mode, setMode] = useState<CarrierMode>('pending')
  const [note, setNote] = useState<string>('')

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let disposed = false
    let disposeView: (() => void) | undefined

    const bridge = (window as unknown as { dshDesktop?: DesktopBridge }).dshDesktop
    const acquire = bridge?.browser?.acquire
    const release = bridge?.browser?.release

    // 偏好里显式要求外置承载时，不做内嵌。
    if (preference === 'browser') {
      window.open(entryUrl, '_blank', 'noopener')
      setMode('external')
      setNote('已按配置（openMode: browser）在系统浏览器打开')
      return
    }
    if (preference === 'rightbar') {
      if (services.rightbar !== undefined) {
        services.rightbar.openTab('browser', { params: { url: entryUrl } })
        services.layout?.openRightbar(false, true)
        setMode('rightbar')
        setNote('已按配置（openMode: rightbar）在右栏的浏览器标签中打开')
      } else {
        setMode('iframe')
        setNote('右栏服务不可用（未启用 ui-sidebar-browser），退回内嵌框架')
      }
      return
    }

    const useWebview = async (): Promise<boolean> => {
      if (preference === 'iframe') return false
      if (typeof acquire !== 'function' || typeof release !== 'function') {
        if (preference === 'webview') setNote('桌面桥不可用（当前是纯 Web 外壳），退回内嵌框架')
        return false
      }
      try {
        const { lease, partition } = await acquire(PANEL_ID)
        if (disposed) {
          void release(lease)
          return true
        }
        // 先挂 about:blank#<lease>：主进程的 will-attach-webview 只放行带合法 lease 的挂载。
        const view = document.createElement('webview') as HTMLElement & {
          setAttribute(name: string, value: string): void
        }
        view.setAttribute('src', `about:blank#${lease}`)
        view.setAttribute('partition', partition)
        view.setAttribute('allowpopups', 'false')
        view.className = 'drd-frame'
        host.appendChild(view)
        view.addEventListener('dom-ready', () => {
          if (!disposed) view.setAttribute('src', entryUrl)
        })
        disposeView = () => {
          try {
            view.remove()
          } catch {
            /* 已经移除 */
          }
          void release(lease)
        }
        setMode('webview')
        setNote('桌面原生视图（官方 webview lease）')
        return true
      } catch (error) {
        setNote(`webview 不可用，降级为内嵌框架：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }

    void (async () => {
      if (await useWebview()) return
      if (disposed) return
      setMode('iframe')
      setNote((current) => current || '内嵌框架（iframe）')
    })()

    return () => {
      disposed = true
      disposeView?.()
    }
  }, [entryUrl, preference, services])

  if (mode === 'external' || mode === 'rightbar') {
    return (
      <div className="drd-stage">
        <div className="drd-placeholder">
          {note}
          <br />
          <span className="drd-mono">{entryUrl}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="drd-stage">
      <div ref={hostRef} style={{ width: '100%', height: '100%' }}>
        {mode === 'iframe' ? (
          <iframe
            className="drd-frame"
            src={entryUrl}
            title={`${label} 的镜像`}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
          />
        ) : null}
      </div>
      {mode === 'pending' ? <div className="drd-placeholder">正在打开镜像…</div> : null}
      {mode !== 'pending' && note !== '' ? (
        <div className="drd-meta" style={{ padding: '6px 16px' }}>
          {note}
        </div>
      ) : null}
    </div>
  )
}

/* ── 组件 ── */

function phaseText(instance: InstanceSnapshot): string {
  if (instance.phase === 'running') return instance.remotePort === undefined ? '运行中' : `运行中 · 远端 ${String(instance.remotePort)}`
  if (instance.phase === 'starting') return '启动中'
  if (instance.phase === 'stopping') return '停止中'
  if (instance.phase === 'error') return `出错：${instance.error ?? instance.detail}`
  return '未启动'
}

function Panel(props: PanelServices): ReactNode {
  const { instances, error, act, refresh } = useInstances()
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [checks, setChecks] = useState<CheckState | undefined>(undefined)
  // 容器偏好来自配置；读一次即可，不必轮询。
  const host = useHostReport()
  const preference: CarrierPreference =
    host.state.phase === 'ready' ? (host.state.value.config.openMode as CarrierPreference) : 'auto'

  const active = instances.find((instance) => instance.id === selected) ?? instances[0]
  const open = active?.phase === 'running' && typeof active.mirrorEntryUrl === 'string' ? active.mirrorEntryUrl : undefined
  const logs = useInstanceLogs(active?.id, active !== undefined && active.phase !== 'stopped')

  const run = async (id: string, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    setBusy(`${id}:${action}`)
    try {
      await act(id, action)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="drd-root">
      <div className="drd-bar">
        <h1 className="drd-title">{DISPLAY_NAME}</h1>
        <span className="drd-badge">{instances.length === 0 ? '未配置实例' : `${String(instances.length)} 个实例`}</span>
        <div className="drd-spacer" />
        <button type="button" className="drd-btn" onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {error === undefined ? null : <div className="drd-error">控制接口报错：{error}</div>}

      <div className="drd-body">
        <div className="drd-list">
          {instances.length === 0 ? (
            <div className="drd-meta">
              还没有配置实例。在 profile 的 <span className="drd-mono">cordis.patch.yml</span> 里给
              <span className="drd-mono"> remote-desks </span>加上 <span className="drd-mono">instances</span> 即可。
            </div>
          ) : (
            instances.map((instance) => (
              <button
                key={instance.id}
                type="button"
                className="drd-item"
                data-active={active?.id === instance.id}
                onClick={() => setSelected(instance.id)}
              >
                <span className="drd-item-top">
                  <span className="drd-dot" data-phase={instance.phase} />
                  <span className="drd-name">{instance.label}</span>
                </span>
                <span className="drd-meta">
                  {instance.kind === 'local' ? '本机' : instance.kind === 'wsl' ? 'WSL' : 'SSH'} · {phaseText(instance)}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="drd-main">
          {active === undefined ? (
            <div className="drd-placeholder">左侧还没有实例。</div>
          ) : (
            <>
              <div className="drd-toolbar">
                <strong>{active.label}</strong>
                <span className="drd-meta">{active.detail}</span>
                <div className="drd-spacer" />
                <button
                  type="button"
                  className="drd-btn"
                  disabled={busy !== undefined}
                  onClick={() => {
                    setChecks({ phase: 'loading' })
                    fetch(`${INSTANCES_URL}/${encodeURIComponent(active.id)}/check`, {
                      headers: { accept: 'application/json' },
                    })
                      .then(async (response) => {
                        if (!response.ok) throw new Error(`HTTP ${response.status}`)
                        const body = (await response.json()) as { checks?: PreflightItem[] }
                        setChecks({ phase: 'ready', items: body.checks ?? [] })
                      })
                      .catch((error: unknown) =>
                        setChecks({ phase: 'error', message: error instanceof Error ? error.message : String(error) }),
                      )
                  }}
                >
                  预检
                </button>
                <button
                  type="button"
                  className="drd-btn"
                  disabled={active.phase === 'running' || busy !== undefined}
                  onClick={() => void run(active.id, 'start')}
                >
                  启动
                </button>
                <button
                  type="button"
                  className="drd-btn"
                  disabled={active.phase === 'stopped' || busy !== undefined}
                  onClick={() => void run(active.id, 'restart')}
                >
                  重启
                </button>
                <button
                  type="button"
                  className="drd-btn"
                  disabled={active.phase === 'stopped' || busy !== undefined}
                  onClick={() => void run(active.id, 'stop')}
                >
                  停止
                </button>
                <button
                  type="button"
                  className="drd-btn"
                  disabled={open === undefined}
                  onClick={() => {
                    if (open !== undefined) window.open(open, '_blank', 'noopener')
                  }}
                  title="用系统浏览器打开镜像地址"
                >
                  浏览器打开
                </button>
              </div>

              {checks === undefined ? null : <CheckList state={checks} onClose={() => setChecks(undefined)} />}

              {open === undefined ? (
                <div className="drd-placeholder">
                  {active.phase === 'running' ? '正在准备镜像端点…' : '实例未运行。点「启动」后这里会显示它的完整界面。'}
                </div>
              ) : (
                <MirrorStage entryUrl={open} label={active.label} preference={preference} services={props} />
              )}

              <LogDrawer lines={logs.lines} onClear={logs.clear} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 日志抽屉：默认折叠，标题行显示条数；展开后自动贴底。 */
function LogDrawer({ lines, onClear }: { lines: string[]; onClear: () => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    if (!open) return
    const node = ref.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [lines, open])

  return (
    <>
      <div className="drd-toolbar" style={{ borderTop: '1px solid var(--dsw-alias-border-l1, currentColor)', borderBottom: 'none' }}>
        <button type="button" className="drd-btn" onClick={() => setOpen((value) => !value)}>
          {open ? '收起日志' : `展开日志（${String(lines.length)} 行）`}
        </button>
        {open && lines.length > 0 ? (
          <button type="button" className="drd-btn" onClick={onClear}>
            清屏
          </button>
        ) : null}
      </div>
      {open ? (
        <pre className="drd-logs" ref={ref} style={{ maxHeight: '240px' }}>
          {lines.length === 0 ? '（还没有日志）' : lines.join('\n')}
        </pre>
      ) : null}
    </>
  )
}

interface PreflightItem {
  name: string
  ok: boolean
  detail: string
}

type CheckState = { phase: 'loading' } | { phase: 'ready'; items: PreflightItem[] } | { phase: 'error'; message: string }

/** 预检结果：一行一项，红绿一眼可见。 */
function CheckList({ state, onClose }: { state: CheckState; onClose: () => void }): ReactNode {
  if (state.phase === 'loading') return <div className="drd-card">正在预检…</div>
  if (state.phase === 'error') return <div className="drd-error">预检失败：{state.message}</div>
  return (
    <div className="drd-card">
      <h3>
        预检结果
        <button type="button" className="drd-btn" style={{ marginLeft: 10 }} onClick={onClose}>
          收起
        </button>
      </h3>
      <div className="drd-grid">
        {state.items.map((item) => (
          <Row key={item.name} label={item.name}>
            <span className="drd-chip" data-on={item.ok ? 'true' : 'false'}>
              {item.ok ? '通过' : '不通过'}
            </span>
            <span className="drd-mono" style={{ marginLeft: 8 }}>
              {item.detail}
            </span>
          </Row>
        ))}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <>
      <div className="drd-key">{label}</div>
      <div>{children}</div>
    </>
  )
}

function CapabilityCard({ report }: { report: HostReport }): ReactNode {
  const desktop = typeof window !== 'undefined' && (window as { dshDesktop?: unknown }).dshDesktop !== undefined
  return (
    <div className="drd-card">
      <h3>宿主能力</h3>
      <div className="drd-grid">
        <Row label="运行形态">{desktop ? '桌面版（Electron 外壳）' : '纯 Web 版（浏览器外壳）'}</Row>
        <Row label="平台">
          {report.host.platform} / {report.host.arch} ｜ Node {report.host.node}
          {report.host.electron === null ? '' : ` ｜ Electron ${report.host.electron}`}
        </Row>
        <Row label="DSH 发行版">
          {report.runtime.found ? (
            <span className="drd-mono">
              {report.runtime.version ?? '版本未知'}
              {report.runtime.inAsar === true ? '（app.asar 内）' : ''} ｜ 来自 {report.runtime.via ?? '未知策略'}
              <br />
              {report.runtime.entry ?? ''}
            </span>
          ) : (
            <span className="drd-mono">
              未解析到。已尝试：
              {report.runtime.attempts.map((attempt) => `${attempt.via}(${attempt.detail})`).join('；')}
            </span>
          )}
        </Row>
        <Row label="DSH_HOME">
          <span className="drd-mono">
            {report.host.dshHome ?? '（未设置）'}
            {report.host.dshProfile === null ? '' : ` ｜ profile ${report.host.dshProfile}`}
          </span>
        </Row>
        <Row label="控制接口">
          <span className="drd-mono">
            {report.control.prefix}/api/state ｜ 闸门 {report.control.gate}
          </span>
        </Row>
        <Row label="宿主服务">
          <div className="drd-chips">
            {Object.entries(report.services).map(([key, present]) => (
              <span key={key} className="drd-chip" data-on={present ? 'true' : 'false'}>
                {key}
              </span>
            ))}
          </div>
        </Row>
      </div>
    </div>
  )
}

function SettingsSection(): ReactNode {
  const { state, reload } = useHostReport()
  return (
    <div className="drd-root">
      <div className="drd-bar">
        <h1 className="drd-title">{DISPLAY_NAME} · 设置</h1>
        <div className="drd-spacer" />
        <button type="button" className="drd-btn" onClick={reload}>
          重新探测
        </button>
      </div>
      <div className="drd-scroll">
        {state.phase === 'error' ? <div className="drd-error">读取宿主状态失败：{state.message}</div> : null}
        {state.phase === 'ready' ? <CapabilityCard report={state.value} /> : null}
        <div className="drd-card">
          <h3>配置示例</h3>
          <pre className="drd-mono">{`- id: remote-desks
  config:
    instances:
      - id: wsl-ubuntu
        kind: wsl
        distro: Ubuntu-24.04
        cwd: /home/you/project
      - id: local-dev
        kind: local
        profile: mirror-local-dev
        cwd: D:\\work\\demo`}</pre>
          <p className="drd-meta">
            WSL 的默认启动命令已处理 nvm 与 profile 初始化；自定义 <span className="drd-mono">launchCommand</span> 时请保持单行、
            不要使用变量赋值、不要带双引号（wsl.exe 会把它们吃掉）。
          </p>
        </div>
      </div>
    </div>
  )
}

function PanelIcon(props: { size?: number }): ReactNode {
  const size = props.size ?? 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="4" width="13" height="10" rx="1.6" />
      <path d="M6.5 18h6" />
      <rect x="15.5" y="9.5" width="6" height="10.5" rx="1.6" />
      <path d="M17.5 13.5h2.4m-1.2 -1.4v2.8" />
    </svg>
  )
}

/** 需要的客户端服务：插槽注册表。 */
export const inject = ['slots']

/**
 * 客户端入口：注册面板入口、主面板与设置页。
 *
 * 三处注册都用 `ctx.slots.inject`，因此不依赖声明顺序——对应 slot 一出现就会挂上。
 */
export function apply(ctx: ClientContext): void {
  ensureStyles()

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => DISPLAY_NAME },
      PanelIcon as never,
    ),
  )

  ctx.slots.inject('main', () =>
    // 把宿主服务随 slot 注入，面板因此能按 openMode 使用官方右栏浏览器标签。
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ layout: ctx.layout, rightbar: ctx.sidebarRight }),
      },
      Panel as never,
    ),
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: PANEL_ID, order: 60, label: () => DISPLAY_NAME },
      SettingsSection as never,
    ),
  )
}

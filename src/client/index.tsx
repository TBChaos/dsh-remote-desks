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

interface UpdateRecordView {
  from?: string
  to?: string
  command: string
  at: number
  ok: boolean
  detail: string
  kind: 'update' | 'rollback'
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
  /** 已知的 DSH 版本（启动或预检时探测）。 */
  version?: string
  /** 最近一次更新/回滚。 */
  lastUpdate?: UpdateRecordView
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
  /** webview 挂上了、也导航了，但 guest 里看起来是空的——给用户一个手动换载体的出口。 */
  const [stuck, setStuck] = useState(false)
  const toIframeRef = useRef<(() => void) | undefined>(undefined)
  const switchToIframe = (): void => {
    toIframeRef.current?.()
  }

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let disposed = false
    let disposeView: (() => void) | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let probeTimer: ReturnType<typeof setTimeout> | undefined

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
      if (services.rightbar === undefined) {
        setMode('iframe')
        setNote('右栏服务不可用，退回内嵌框架')
        return
      }
      // 右栏是**会话作用域**的，而我们的全页面板恰好占着主区——只要它还显示着，会话工作面
      // 就没挂载，openTab 会抛 "no session surface is mounted"。
      // 所以顺序是：先把主区切回对话 → 等会话工作面挂上（重试几次）→ 再把镜像开进右栏；
      // 始终开不成的话退回本面板的 iframe 载体，并说明原因——不能留一个空白面板。
      services.layout?.selectPanel('conversation')
      setMode('rightbar')
      setNote('正在把镜像开进右栏…')

      let attempts = 0
      const tryOpen = (): void => {
        if (disposed) return
        attempts += 1
        try {
          services.rightbar?.openTab('browser', { params: { url: entryUrl } })
          services.layout?.openRightbar(false, true)
          setNote('已把镜像开在右栏的浏览器标签里（主区已切回对话）')
        } catch (error) {
          if (attempts < 6) {
            setTimeout(tryOpen, 500)
            return
          }
          // 退回来：重新选中本面板，并改用内嵌框架。
          services.layout?.selectPanel(PANEL_ID)
          setMode('iframe')
          setNote(
            `右栏浏览器标签不可用，已退回内嵌框架：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      setTimeout(tryOpen, 500)
      return
    }

    const useWebview = async (): Promise<boolean> => {
      if (preference === 'iframe') return false
      if (typeof acquire !== 'function' || typeof release !== 'function') {
        if (preference === 'webview') setNote('桌面桥不可用（当前是纯 Web 外壳），退回内嵌框架')
        return false
      }
      try {
        const granted = await acquire(PANEL_ID)
        if (disposed) {
          void release(granted?.lease)
          return true
        }
        const lease = granted?.lease
        const partition = granted?.partition
        // 租约不完整就别往下走：拿 undefined 当 partition 会挂出一个永远加载不出来的视图。
        if (typeof lease !== 'string' || typeof partition !== 'string' || lease === '' || partition === '') {
          setNote('桌面桥返回的租约不完整，退回内嵌框架')
          return false
        }
        // 先挂 about:blank#<lease>：主进程的 will-attach-webview 只放行带合法 lease 的挂载。
        // partition 要在 src 之前设置——它必须在首次导航前就位，顺序反了会踩 Electron 的警告路径。
        const view = document.createElement('webview') as HTMLElement & {
          setAttribute(name: string, value: string): void
          /** `<webview>` 特有：在 guest 里执行脚本（跨源也能用，因为宿主掌握它的 webContents）。 */
          executeJavaScript(code: string): Promise<unknown>
        }
        view.setAttribute('partition', partition)
        view.setAttribute('src', `about:blank#${lease}`)
        view.setAttribute('allowpopups', 'false')
        view.className = 'drd-frame'
        host.appendChild(view)

        // 这条路唯一测不到（放行权在桌面主进程手里），所以三道兜底缺一不可：
        // 租约不完整、加载失败、以及"什么都没发生"——都退到内嵌框架并写明原因，
        // 不能让用户对着空白框发呆。
        const fallback = (reason: string): void => {
          if (disposed) return
          disposeView?.()
          disposeView = undefined
          setMode('iframe')
          setNote(reason)
        }
        toIframeRef.current = () => {
          fallback('已按你的选择改用内嵌框架。')
        }
        watchdog = setTimeout(() => {
          fallback('桌面原生视图 8 秒内没有就绪（可能是主进程拒绝了挂载：租约或 partition 不匹配）。已改用内嵌框架。')
        }, 8_000)
        view.addEventListener('dom-ready', () => {
          if (watchdog !== undefined) {
            clearTimeout(watchdog)
            watchdog = undefined
          }
          if (!disposed) view.setAttribute('src', entryUrl)
        })
        // 加载结束再看一眼 guest 里到底有没有东西：挂上了却渲染不出来，是这个载体唯一
        // 测不到的那半边最容易出的岔子。探测只用来提示，不自动拆视图（可能只是慢）。
        // did-finish-load 未必会来（被拒或一直挂着都会有），所以再加一次定时兜底。
        let probed = false
        const probeGuest = (): void => {
          if (probed || disposed) return
          probed = true
          void (async () => {
            try {
              const probe = await Promise.race([
                view.executeJavaScript('document.body ? document.body.childElementCount : -1'),
                new Promise((done) => setTimeout(() => done(-2), 5_000)),
              ])
              if (disposed || typeof probe !== 'number' || probe > 0) return
              setStuck(true)
              setNote(
                '桌面原生视图已加载，但里面看起来是空的（远端界面可能没渲染出来）。可以点右侧按钮改用内嵌框架。',
              )
            } catch {
              /* 探测本身失败就当没发生，不要因此打断镜像 */
            }
          })()
        }
        view.addEventListener('did-finish-load', probeGuest)
        probeTimer = setTimeout(probeGuest, 6_000)
        view.addEventListener('did-fail-load', (event: Event) => {
          const detail = event as unknown as { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
          if (detail.isMainFrame === false) return
          // -3 = ERR_ABORTED：重定向或新导航顶掉旧导航时**正常**会触发。
          // 镜像端点恰好是"带票据 → 302 落到 /"，把它当失败会自己把刚挂上的视图拆掉。
          if (detail.errorCode === -3) return
          fallback(`桌面原生视图加载失败（${detail.errorDescription ?? '未知原因'}）。已改用内嵌框架。`)
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
      if (watchdog !== undefined) clearTimeout(watchdog)
      if (probeTimer !== undefined) clearTimeout(probeTimer)
      toIframeRef.current = undefined
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
        <div className="drd-meta" style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{note}</span>
          {mode === 'webview' && stuck ? (
            // 兜底出口：桌面那条路我测不到主进程那半边，万一挂上了却渲染不出来，
            // 用户得有一键换载体的办法，而不是去改配置重启。
            <button type="button" className="drd-btn" onClick={switchToIframe}>
              改用内嵌框架
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* ── 组件 ── */

/** 实例列表（纯展示，便于带数据渲染测试）。 */
export function InstanceList({
  instances,
  activeId,
  onSelect,
}: {
  instances: InstanceSnapshot[]
  activeId: string | undefined
  onSelect: (id: string) => void
}): ReactNode {
  if (instances.length === 0) {
    return (
      <div className="drd-meta">
        <div>
          还没有配置实例。在 profile 的 <span className="drd-mono">cordis.patch.yml</span> 里给
          <span className="drd-mono"> remote-desks </span>加上 <span className="drd-mono">instances</span> 即可。
        </div>
        <div style={{ marginTop: 6 }}>
          已经写了却还是空的？那多半是某个字段没通过校验——插件只拿得到校验后的配置，宿主日志里会有
          <span className="drd-mono"> ValidationError: invalid config </span>
          原文。常见坑：<span className="drd-mono">kind</span> 不是 local/wsl/ssh、
          <span className="drd-mono">mirror.portRange</span> 不是两个数字、
          <span className="drd-mono">openMode</span> 不在 auto/webview/iframe/browser/rightbar 里。
        </div>
      </div>
    )
  }
  return (
    <>
      {instances.map((instance) => (
        <button
          key={instance.id}
          type="button"
          className="drd-item"
          data-active={activeId === instance.id}
          onClick={() => onSelect(instance.id)}
        >
          <span className="drd-item-top">
            <span className="drd-dot" data-phase={instance.phase} />
            <span className="drd-name">{instance.label}</span>
          </span>
          <span className="drd-meta">
            {instance.kind === 'local' ? '本机' : instance.kind === 'wsl' ? 'WSL' : 'SSH'} · {phaseText(instance)}
          </span>
        </button>
      ))}
    </>
  )
}

/** 实例工具栏（纯展示）：预检 / 启动 / 重启 / 停止 / 更新 / 回滚 / 浏览器打开。 */
export function InstanceToolbar({
  instance,
  busy,
  mirrorEntryUrl,
  onAction,
  onCheck,
  onUpdate,
  onRollback,
}: {
  instance: InstanceSnapshot
  busy: string | undefined
  mirrorEntryUrl: string | undefined
  onAction: (id: string, action: 'start' | 'stop' | 'restart') => void
  onCheck: (id: string) => void
  onUpdate: (id: string) => void
  onRollback: (id: string) => void
}): ReactNode {
  const stopped = instance.phase === 'stopped'
  const last = instance.lastUpdate
  return (
    <>
      <div className="drd-toolbar">
        <strong>{instance.label}</strong>
        <span className="drd-meta">
          {instance.detail}
          {instance.version === undefined ? '' : ` ｜ DSH ${instance.version}`}
        </span>
        <div className="drd-spacer" />
        <button type="button" className="drd-btn" disabled={busy !== undefined} onClick={() => onCheck(instance.id)}>
          预检
        </button>
        <button
          type="button"
          className="drd-btn"
          disabled={instance.phase === 'running' || busy !== undefined}
          onClick={() => onAction(instance.id, 'start')}
        >
          启动
        </button>
        <button
          type="button"
          className="drd-btn"
          disabled={instance.phase === 'stopped' || busy !== undefined}
          onClick={() => onAction(instance.id, 'restart')}
        >
          重启
        </button>
        <button
          type="button"
          className="drd-btn"
          disabled={instance.phase === 'stopped' || busy !== undefined}
          onClick={() => onAction(instance.id, 'stop')}
        >
          停止
        </button>
        <button
          type="button"
          className="drd-btn"
          title="升级这个实例上安装的 DSH（需先停止）"
          disabled={!stopped || busy !== undefined}
          onClick={() => onUpdate(instance.id)}
        >
          更新
        </button>
        {last === undefined ? null : (
          <button
            type="button"
            className="drd-btn"
            title={`回滚到 ${last.from ?? '上一个版本'}`}
            disabled={!stopped || busy !== undefined || last.from === undefined || !last.ok}
            onClick={() => onRollback(instance.id)}
          >
            回滚
          </button>
        )}
        <button
          type="button"
          className="drd-btn"
          disabled={mirrorEntryUrl === undefined}
          onClick={() => {
            if (mirrorEntryUrl !== undefined) window.open(mirrorEntryUrl, '_blank', 'noopener')
          }}
          title="用系统浏览器打开镜像地址"
        >
          浏览器打开
        </button>
      </div>
      {last === undefined ? null : (
        <div className="drd-meta" style={{ padding: '6px 16px' }}>
          {last.kind === 'update' ? '上次更新' : '上次回滚'}（{last.ok ? '成功' : '失败'}）：
          {last.from ?? '未知'} → {last.to ?? '未知'} ｜ {last.detail}
        </div>
      )}
    </>
  )
}

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

  /** 更新 / 回滚：都是 POST 一个动作，结束后刷新列表让版本与结果立刻可见。 */
  const runLifecycle = async (id: string, action: 'update' | 'rollback'): Promise<void> => {
    setBusy(`${id}:${action}`)
    setChecks(undefined)
    try {
      const response = await fetch(`${INSTANCES_URL}/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string }
        setChecks({ phase: 'error', message: body.message ?? `HTTP ${response.status}` })
      }
    } catch (error) {
      setChecks({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
      await refresh()
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
          <InstanceList instances={instances} activeId={active?.id} onSelect={setSelected} />
        </div>

        <div className="drd-main">
          {active === undefined ? (
            <div className="drd-placeholder">左侧还没有实例。</div>
          ) : (
            <>
              <InstanceToolbar
                instance={active}
                busy={busy}
                mirrorEntryUrl={open}
                onAction={(id, action) => void run(id, action)}
                onUpdate={(id) => void runLifecycle(id, 'update')}
                onRollback={(id) => void runLifecycle(id, 'rollback')}
                onCheck={(id) => {
                  setChecks({ phase: 'loading' })
                  fetch(`${INSTANCES_URL}/${encodeURIComponent(id)}/check`, {
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
              />

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

/**
 * 需要的客户端服务。
 *
 * `layout` 必须在这里声明：slot 的 inject 回调里直接读 `ctx.layout`，而 Cordis 对未声明
 * 的服务会抛 "cannot get property ... without inject"——实测这个异常会让面板根本注册不上
 * （浏览器验证抓到的，冒烟/SSR/HTTP 都看不到）。`sidebarRight` 是可选能力，走 `ctx.get()`。
 */
export const inject = ['slots', 'layout']

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
    // sidebarRight 是可选能力（要装了 ui-sidebar-browser 才有），所以用 ctx.get 探测。
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ layout: ctx.layout, rightbar: ctx.get?.('sidebarRight') as RightbarService | undefined }),
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

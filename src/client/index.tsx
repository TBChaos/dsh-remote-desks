import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import {
  activeInstance,
  checkInstance,
  collapseSidebarPreferred,
  describe as describeError,
  ensureRunning,
  layoutModeOf,
  lifecycleAction,
  longStatus,
  refreshWorkbench,
  selectInstance,
  setLayoutMode,
  shortLabel,
  shortStatus,
  useInstanceLogs,
  useWorkbenchStore,
  versionAction,
  type HostReport,
  type InstanceSnapshot,
  type LayoutMode,
  type PreflightItem,
  type WorkbenchStore,
} from './workbench'

/** 与 host 半共享的面板 id：sidebar 入口与 main 面板用同一个值。 */
export const PANEL_ID = 'remote-desks'
/** 控制接口前缀，与 host 半的 CONTROL_PREFIX 保持一致。 */
export const CONTROL_PREFIX = '/remote-desks'
/** 展示名（中文优先）。 */
export const DISPLAY_NAME = '远端工作台'
/** 窗口角上那个「本机 / WSL」切换下拉框的 id。 */
export const SWITCHER_ID = `${PANEL_ID}.switcher`

// 纯函数（短标签 / 形态判定）在这里再导出一次：冒烟测试要在真实产物上直接断言它们，
// 而 bundle 的工厂只返回本模块的导出。
export { kindText, layoutModeOf, longStatus, shortLabel, shortStatus } from './workbench'

const STYLE_MARKER = 'dsh-remote-desks/client.css'
/** 统一界面里同时保活几台镜像（隐藏但没卸载）：切回来是瞬间的。 */
const KEEP_ALIVE = 3

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
  /** 官方侧栏开关（收起 ⟷ 展开）：统一界面时用它把侧栏收成窄条，让远端 UI 拿到整扇窗。 */
  toggleSidebar?(): void
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

/* 窗口上边的机器切换器。shell.overlay 那一层是点击穿透的（官方给它的直接子元素补了
   pointer-events: auto，这里也显式写上，免得依赖别人的 CSS），所以它自己就是个可点的浮层。
   位置由 useSwitcherPlacement 现算：桌面版钻进标题栏那条带子（中间是空的，谁也不挡），
   没有标题栏的纯 Web 外壳则落在官方给浮层准备的 --dsh-frame-overlay-top 上。
   -webkit-app-region: no-drag 必须有：标题栏那条带子是窗口拖动区，不声明就点不动。 */
.drd-switch { position: fixed; z-index: 30; display: flex; align-items: center; gap: 8px; pointer-events: auto;
  -webkit-app-region: no-drag; padding: 4px 8px; border-radius: 999px; font-size: 12px; max-width: min(60vw, 460px);
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-1, rgba(20,22,28,.72));
  border: 1px solid var(--dsw-alias-border-l1, currentColor); box-shadow: 0 4px 14px rgba(0,0,0,.18); }
.drd-switch[data-corner="top-center"] { left: 50%; transform: translateX(-50%); top: var(--drd-switch-y, var(--dsh-frame-overlay-top, 20px)); }
.drd-switch[data-corner="top-right"] { right: var(--drd-switch-x, 56px); top: var(--drd-switch-y, var(--dsh-frame-overlay-top, 20px)); }
.drd-switch[data-corner="top-left"] { left: var(--drd-switch-x, 56px); top: var(--drd-switch-y, var(--dsh-frame-overlay-top, 20px)); }
.drd-switch select { font: inherit; font-size: 12px; max-width: 220px; min-width: 0; padding: 2px 6px; border-radius: 999px; cursor: pointer;
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, transparent);
  border: 1px solid var(--dsw-alias-border-l1, currentColor); }
.drd-switch .drd-name { max-width: 200px; }
.drd-switch .drd-meta { margin-top: 0; white-space: nowrap; }
/* 钻进标题栏带子里时更矮一点：那条带子只有几十像素高。 */
.drd-switch[data-band="chrome"] { padding: 2px 8px; }

/* 切换器是浮在帧上的，会压到本面板右上角那一排按钮——所以表头自己让出这段宽度（由切换器实测后
   写进 --drd-switch-reserve）。只让表头：工具栏在它下面一行，硬让会把按钮挤成两行。
   别的面板不归我们管，靠 offsetX 默认值躲开官方那颗侧栏开关。 */
.drd-bar { padding-right: max(18px, var(--drd-switch-reserve, 0px)); }

/* ── 统一界面（immersive）：远端那套 DSH 自己的界面铺满主区，我们只剩一条很轻的浮条 ── */
.drd-immersive { position: relative; }
.drd-immersive .drd-stage { position: absolute; inset: 0; }
/* 保活的镜像：隐藏但没卸载，切回来立刻就是它（连 WS 都还连着）。 */
.drd-keep { position: absolute; inset: 0; }
.drd-keep[hidden] { display: none; }
.drd-immersive .drd-placeholder { flex-direction: column; gap: 12px; }
.drd-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; pointer-events: none; }
.drd-float { position: absolute; right: 12px; bottom: 12px; z-index: 5; display: flex; align-items: center; gap: 8px;
  padding: 4px 8px; border-radius: 999px; font-size: 12px; opacity: .45; transition: opacity .15s ease;
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-1, rgba(20,22,28,.72));
  border: 1px solid var(--dsw-alias-border-l1, currentColor); box-shadow: 0 4px 14px rgba(0,0,0,.18); }
.drd-float:hover, .drd-float:focus-within { opacity: 1; }
.drd-float .drd-name { max-width: 180px; }
.drd-float .drd-meta { margin-top: 0; }
.drd-float-note { position: absolute; left: 12px; bottom: 12px; z-index: 5; max-width: 46%;
  padding: 4px 8px; border-radius: 8px; font-size: 12px; opacity: .8;
  color: var(--dsw-alias-label-secondary, inherit); background: var(--dsw-alias-bg-layer-1, rgba(20,22,28,.72));
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
  floatingNote,
  onNote,
}: {
  entryUrl: string
  label: string
  preference: CarrierPreference
  services: PanelServices
  /** 统一界面下镜像铺满主区，说明那行改成左下角的浮条（不然会被裁掉）。 */
  floatingNote?: boolean
  /** 把当前那行说明回带出去（诊断文本要用）。 */
  onNote?: (value: string) => void
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [mode, setMode] = useState<CarrierMode>('pending')
  const [note, setNote] = useState<string>('')
  /** 内嵌框架的 load 有没有来过——远端前端还要自己挂载，这期间给一句说明。 */
  const [frameReady, setFrameReady] = useState(false)
  /** webview 挂上了、也导航了，但 guest 里看起来是空的——给用户一个手动换载体的出口。 */
  const [stuck, setStuck] = useState(false)
  const toIframeRef = useRef<(() => void) | undefined>(undefined)
  const switchToIframe = (): void => {
    toIframeRef.current?.()
  }
  /**
   * 宿主服务只有第一次渲染才需要（`openMode: rightbar` 会用到），但它每次渲染都是新的对象。
   *
   * 这一条不是洁癖，是实测出来的**抖动源**：外壳频繁重渲染时会给出新的 props，
   * 而载体 effect 的依赖里一旦放进这个对象，每个渲染周期都会「拆掉视图 → 重新挂一个」，
   * 表现就是镜像区一直在闪、什么都显示不出来。所以用 ref 读，不让它进依赖数组。
   */
  const servicesRef = useRef(services)
  servicesRef.current = services

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const servicesNow = servicesRef.current
    let disposed = false
    let disposeView: (() => void) | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let postNavWatchdog: ReturnType<typeof setTimeout> | undefined
    let probeTimer: ReturnType<typeof setTimeout> | undefined

    const bridge = (window as unknown as { dshDesktop?: DesktopBridge }).dshDesktop
    const acquire = bridge?.browser?.acquire
    const release = bridge?.browser?.release

    const clearTimers = (): void => {
      for (const timer of [watchdog, postNavWatchdog, probeTimer]) {
        if (timer !== undefined) clearTimeout(timer)
      }
      watchdog = undefined
      postNavWatchdog = undefined
      probeTimer = undefined
    }

    // 偏好里显式要求外置承载时，不做内嵌。
    if (preference === 'browser') {
      window.open(entryUrl, '_blank', 'noopener')
      setMode('external')
      setNote('已按配置（openMode: browser）在系统浏览器打开')
      return
    }
    if (preference === 'rightbar') {
      if (servicesNow.rightbar === undefined) {
        setMode('iframe')
        setNote('右栏服务不可用，退回内嵌框架')
        return
      }
      // 右栏是**会话作用域**的，而我们的全页面板恰好占着主区——只要它还显示着，会话工作面
      // 就没挂载，openTab 会抛 "no session surface is mounted"。
      // 所以顺序是：先把主区切回对话 → 等会话工作面挂上（重试几次）→ 再把镜像开进右栏；
      // 始终开不成的话退回本面板的 iframe 载体，并说明原因——不能留一个空白面板。
      servicesNow.layout?.selectPanel('conversation')
      setMode('rightbar')
      setNote('正在把镜像开进右栏…')

      let attempts = 0
      const tryOpen = (): void => {
        if (disposed) return
        attempts += 1
        try {
          servicesNow.rightbar?.openTab('browser', { params: { url: entryUrl } })
          servicesNow.layout?.openRightbar(false, true)
          setNote('已把镜像开在右栏的浏览器标签里（主区已切回对话）')
        } catch (error) {
          if (attempts < 6) {
            setTimeout(tryOpen, 500)
            return
          }
          // 退回来：重新选中本面板，并改用内嵌框架。
          servicesNow.layout?.selectPanel(PANEL_ID)
          setMode('iframe')
          setNote(
            `右栏浏览器标签不可用，已退回内嵌框架：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      setTimeout(tryOpen, 500)
      return
    }

    /**
     * 走不走桌面原生视图（官方 webview lease）。
     *
     * `auto` **不再**先试它：那条路要申请租约、等主进程放行、挂 about:blank、再导航，
     * 失败时还要等看门狗超时——用户实测就是"渲染时间过长"。内嵌框架是纯进程内的一个 frame，
     * 立刻就开始加载，而且 M7 修掉跨站票据之后它在桌面版里也能用了。
     * 想要更好的隔离（独立分区、不与应用共享 DOM）就显式写 `openMode: webview`。
     */
    const useWebview = async (): Promise<boolean> => {
      if (preference !== 'webview') return false
      if (typeof acquire !== 'function' || typeof release !== 'function') {
        setNote('桌面桥不可用（当前是纯 Web 外壳），退回内嵌框架')
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
          getURL?(): string
          /** `<webview>` 特有：在 guest 里执行脚本（跨源也能用，因为宿主掌握它的 webContents）。 */
          executeJavaScript(code: string): Promise<unknown>
        }
        view.setAttribute('partition', partition)
        view.setAttribute('src', `about:blank#${lease}`)
        view.setAttribute('allowpopups', 'false')
        view.className = 'drd-frame'
        host.appendChild(view)

        // 这条路唯一测不到（放行权在桌面主进程手里），所以几道兜底缺一不可：
        // 租约不完整、加载失败、导航没发生、以及"挂上了却是空的"——都退到内嵌框架并写明原因，
        // 不能让用户对着空白框发呆。
        const fallback = (reason: string): void => {
          if (disposed) return
          clearTimers()
          disposeView?.()
          disposeView = undefined
          setMode('iframe')
          setNote(reason)
        }
        toIframeRef.current = () => {
          fallback('已按你的选择改用内嵌框架。')
        }
        watchdog = setTimeout(() => {
          fallback(
            '桌面原生视图 6 秒内没有就绪（主进程可能拒绝了挂载：租约或 partition 不匹配）。已改用内嵌框架。',
          )
        }, 6_000)

        /**
         * 只导航一次。
         *
         * 这里踩过一个大坑：早先的写法是"每次 dom-ready 都 setAttribute('src', entryUrl)"，
         * 而 dom-ready 对**每一次**导航都会触发——于是页面加载 → dom-ready → 再设一次 src →
         * 再加载 → …… 无限重载，表现就是镜像区一直在抖、永远渲染不出东西。
         */
        let navigated = false
        let navigatedAt = 0
        view.addEventListener('dom-ready', () => {
          if (disposed || navigated) return
          navigated = true
          navigatedAt = Date.now()
          if (watchdog !== undefined) {
            clearTimeout(watchdog)
            watchdog = undefined
          }
          view.setAttribute('src', entryUrl)
          // 导航之后也要有个上限：did-finish-load 一直不来（被拦、上游挂着）时同样得降级。
          postNavWatchdog = setTimeout(() => {
            fallback('桌面原生视图导航后 8 秒内没有加载完成。已改用内嵌框架。')
          }, 8_000)
        })

        /**
         * 加载结束再看一眼 guest 里到底有没有东西。
         *
         * 这是这个载体唯一测不到的那半边（主进程的放行规则）最容易出的岔子：视图挂上了、
         * 加载也"完成"了，里面却是空的。等一小会儿再探（客户端要时间挂载），确实是空的就
         * 自动换成内嵌框架——用户可以自己点按钮，但更好的做法是不让他对着空白框发呆。
         *
         * **必须在导航之后才探**：`did-finish-load` 对最初那个 `about:blank#<lease>` 也会触发，
         * 那时候 URL 当然是 about:blank——照着它判"没导航"会立刻误报降级
         * （实测：桌面版里一挂上就说"没有导航到镜像地址"，其实导航压根还没开始）。
         */
        let probed = false
        const probeGuest = (): void => {
          if (probed || disposed || !navigated) return
          // 刚发出导航就来的那次"加载结束"，几乎一定是 about:blank 那一跳的尾巴：放它过去，
          // 让真正的导航自己再报一次。
          if (Date.now() - navigatedAt < 1_000) return
          probed = true
          if (postNavWatchdog !== undefined) {
            clearTimeout(postNavWatchdog)
            postNavWatchdog = undefined
          }
          probeTimer = setTimeout(() => {
            void (async () => {
              const current = typeof view.getURL === 'function' ? view.getURL() : ''
              if (typeof current === 'string' && current.startsWith('about:blank')) {
                fallback(
                  `桌面原生视图没有导航到镜像地址（当前地址 ${current.slice(0, 40)}，` +
                    '主进程可能拒绝了挂载）。已改用内嵌框架。',
                )
                return
              }
              let probe = -1
              try {
                probe = (await Promise.race([
                  view.executeJavaScript(
                    '(() => { const b = document.body; if (!b) return -1;' +
                      ' return b.childElementCount + (b.innerText || "").trim().length; })()',
                  ),
                  new Promise((done) => setTimeout(() => done(-2), 5_000)),
                ])) as number
              } catch {
                // 抛异常基本就是"压根没挂上"（主进程拒绝了挂载）——这种更要动手降级，
                // 早期版本在这里 catch 一下就走了，用户只会看到空白。
                setStuck(true)
                fallback('桌面原生视图没能挂上（主进程可能拒绝了挂载）。已改用内嵌框架。')
                return
              }
              if (disposed || typeof probe !== 'number' || probe > 0) return
              setStuck(true)
              fallback('桌面原生视图已加载，但里面看起来是空的（远端界面没渲染出来）。已改用内嵌框架。')
            })()
          }, 2_500)
        }
        view.addEventListener('did-finish-load', probeGuest)
        view.addEventListener('did-stop-loading', probeGuest)
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
      clearTimers()
      toIframeRef.current = undefined
      disposeView?.()
    }
    // 依赖只留这两个：载体只该在"换地址 / 换偏好"时重建一次。
    // services 走 ref（见上面的说明），少了它就不会被外壳的普通重渲染掀掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryUrl, preference])

  useEffect(() => {
    onNote?.(note)
  }, [note, onNote])

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
          // key 用地址：换实例/换端口时是**新的一次导航**，不是复用同一个 iframe——
          // 复用会让旧页面的脚本继续跑在新地址上，看起来像卡住。
          <iframe
            key={entryUrl}
            className="drd-frame"
            src={entryUrl}
            title={`${label} 的镜像`}
            onLoad={() => setFrameReady(true)}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
          />
        ) : null}
      </div>
      {/* 远端那套前端要下几百 KB 的 bundle 再自己挂载，这期间别留一块纯白：说清在等什么。 */}
      {mode === 'iframe' && !frameReady ? (
        <div className="drd-loading">
          <span className="drd-dot" data-phase="starting" />
          正在渲染远端界面…
        </div>
      ) : null}
      {mode === 'pending' ? <div className="drd-placeholder">正在打开镜像…</div> : null}
      {mode !== 'pending' && note !== '' ? (
        floatingNote === true ? (
          // 统一界面：镜像铺满，说明改成左下角一条浮签，别把界面顶下去。
          <div className="drd-float-note" title={note}>
            {note}
          </div>
        ) : (
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
        )
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
  loading,
}: {
  instances: InstanceSnapshot[]
  activeId: string | undefined
  onSelect: (id: string) => void
  /** 第一次拉取还没回来：这时说"正在读取"，而不是急着教用户改配置。 */
  loading?: boolean
}): ReactNode {
  if (loading === true && instances.length === 0) {
    return <div className="drd-meta">正在读取实例列表…</div>
  }
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
  if (instance.phase === 'running') {
    if (instance.attached === true) return `运行中 · 吸附本机 ${String(instance.remotePort ?? '')}`.trim()
    return instance.remotePort === undefined ? '运行中' : `运行中 · 远端 ${String(instance.remotePort)}`
  }
  if (instance.phase === 'starting') return '启动中'
  if (instance.phase === 'stopping') return '停止中'
  if (instance.phase === 'error') return `出错：${instance.error ?? instance.detail}`
  return '未启动'
}

/** 面板要用的动作（由外壳注入，便于带数据渲染测试）。 */
export interface PanelActions {
  refresh(): void
  select(id: string | undefined): void
  lifecycle(id: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; message?: string }>
  version(id: string, action: 'update' | 'rollback'): Promise<{ ok: boolean; message?: string }>
}

export interface PanelViewProps extends PanelServices {
  store: WorkbenchStore
  actions: PanelActions
}

/**
 * 面板本体：**纯渲染**——数据全从 props 来。
 *
 * 这样拆是为了能在没有浏览器、没有宿主的冒烟测试里把"带数据的那一屏"真的渲染一遍
 * （`react-dom/server`），而不是只测几个小组件。
 */
export function PanelView(props: PanelViewProps): ReactNode {
  const { store, actions } = props
  const instances = store.instances.phase === 'ready' ? store.instances.value : []
  const instancesError = store.instances.phase === 'error' ? store.instances.message : undefined
  const loading = store.instances.phase === 'loading'
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [checks, setChecks] = useState<CheckState | undefined>(undefined)
  const [diagnostics, setDiagnostics] = useState<string | undefined>(undefined)
  const [diagnosticsNote, setDiagnosticsNote] = useState<string>('')
  /** 镜像区当前那行说明（哪种容器/降级原因）——诊断文本里最有用的一行，通过回调带上来。 */
  const carrierNoteRef = useRef<string>('')
  // 容器偏好来自配置；宿主能力跟着 store 走（切换器也在读同一份）。
  const preference: CarrierPreference =
    store.host.phase === 'ready' ? (store.host.value.config.openMode as CarrierPreference) : 'auto'

  const active = activeInstance(store)
  const open = active?.phase === 'running' && typeof active.mirrorEntryUrl === 'string' ? active.mirrorEntryUrl : undefined
  const logs = useInstanceLogs(active?.id, active !== undefined && active.phase !== 'stopped')

  const run = async (id: string, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    setBusy(`${id}:${action}`)
    try {
      const result = await actions.lifecycle(id, action)
      if (!result.ok) setChecks({ phase: 'error', message: result.message ?? '操作失败' })
      else setChecks(undefined)
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * 一键攒一份诊断文本：能力矩阵 + 每个实例的状态/版本/最近更新 + 当前实例的日志尾部。
   *
   * 起因很实际——"界面上是什么样"用嘴描述很费劲。用户点一下就拿到一段可以直接粘的文本，
   * 排障时不用来回问。复制失败（无剪贴板权限）就退化成显示出来手动选。
   */
  const collectDiagnostics = async (): Promise<void> => {
    const lines: string[] = ['===== dsh-remote-desks 诊断 =====']
    lines.push(`生成时间：${new Date().toISOString()}`)
    const report = store.host.phase === 'ready' ? store.host.value : undefined
    if (report === undefined) {
      lines.push(`读取能力矩阵失败：${store.host.phase === 'error' ? store.host.message : '尚未就绪'}`)
    } else {
      lines.push(
        `插件：${report.plugin.displayName || report.plugin.name} ${report.plugin.version}` +
          `｜里程碑 ${report.plugin.milestone}`,
      )
      lines.push(
        `运行形态：${report.host.platform}/${report.host.arch}` +
          `｜Node ${report.host.node}` +
          `｜Electron ${report.host.electron === null ? '否' : report.host.electron}` +
          `${report.host.dshProfile === null ? '' : `｜profile ${report.host.dshProfile}`}`,
      )
      lines.push(
        `DSH 运行时：${report.runtime.found ? '找到' : '未找到'}` +
          `${report.runtime.version === undefined ? '' : `｜${report.runtime.version}`}` +
          `｜入口：${report.runtime.entry ?? '未知'}` +
          `${report.runtime.via === undefined ? '' : `（来源 ${report.runtime.via}）`}`,
      )
      lines.push(
        `宿主自身端点：${report.host.webPort === null || report.host.webPort === undefined ? '未知' : `127.0.0.1:${String(report.host.webPort)}`}` +
          `｜可吸附：${report.host.selfAttachable === true ? '是' : '否'}`,
      )
      lines.push(`控制接口：${report.control.prefix}｜闸门：${report.control.gate}`)
      const missing = Object.entries(report.services)
        .filter(([, ok]) => ok !== true)
        .map(([key]) => key)
      lines.push(`宿主服务：${String(Object.keys(report.services).length)} 项，缺 ${missing.length === 0 ? '无' : missing.join(', ')}`)
      lines.push(`容器偏好（openMode）：${preference}｜切换器：${report.config.switcher ?? '未知'}`)
      lines.push(`实例数：${String(instances.length)}`)
    }
    for (const instance of instances) {
      lines.push(
        `- [${instance.id}] ${instance.kind} ${instance.phase}${instance.attached === true ? '（吸附宿主自身）' : ''}` +
          `${instance.version === undefined ? '' : `｜DSH ${instance.version}`}` +
          `${instance.remotePort === undefined ? '' : `｜远端端口 ${String(instance.remotePort)}`}` +
          `｜${instance.detail}` +
          `${instance.error === undefined ? '' : `｜错误：${instance.error}`}`,
      )
      if (instance.lastUpdate !== undefined) {
        lines.push(
          `    上次${instance.lastUpdate.kind === 'update' ? '更新' : '回滚'}：` +
            `${instance.lastUpdate.from ?? '未知'} → ${instance.lastUpdate.to ?? '未知'}｜${instance.lastUpdate.detail}`,
        )
      }
    }
    if (active !== undefined) {
      lines.push(`当前选中：${active.id}｜容器说明：${carrierNoteRef.current === '' ? '（镜像未显示）' : carrierNoteRef.current}`)
      lines.push(`---- 日志尾部（${active.id}）----`)
      for (const line of logs.lines.slice(-40)) lines.push(line)
    }
    const text = lines.join('\n')
    setDiagnostics(text)
    try {
      await navigator.clipboard.writeText(text)
      setDiagnosticsNote('已复制到剪贴板')
    } catch {
      setDiagnosticsNote('复制失败，请手动全选下面的文本')
    }
  }

  /** 更新 / 回滚：都是 POST 一个动作，结束后刷新列表让版本与结果立刻可见。 */
  const runLifecycle = async (id: string, action: 'update' | 'rollback'): Promise<void> => {
    setBusy(`${id}:${action}`)
    setChecks(undefined)
    try {
      const result = await actions.version(id, action)
      if (!result.ok) setChecks({ phase: 'error', message: result.message ?? '操作失败' })
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * 官方的侧栏开关：进统一界面时把它收成窄条，远端 UI 就能拿到整扇窗。
   *
   * 「现在是不是收起状态」只能从 DOM 上读（官方 CSS 里就是 `[data-sidebar-collapsed]`），
   * 读不到就先不点——宁可不动，也不要反着切一次。
   */
  const toggleSidebar = (): void => {
    if (typeof document === 'undefined') return
    props.layout?.toggleSidebar?.()
  }
  const sidebarCollapsed = (): boolean =>
    typeof document !== 'undefined' && document.querySelector('[data-sidebar-collapsed]') !== null

  // 「重载」：换一个 key 把载体整个重挂一次（镜像卡住、或想重新走一遍票据时最省事）。
  // 按实例记：重载的是当前这台，别把后台保活的那几台也掀了。
  const [reloads, setReloads] = useState<Record<string, number>>({})
  /**
   * 最近看过的几台，仍在运行的**保持挂载**（隐藏起来），切回来就是瞬间的事。
   *
   * 起因是实测：每次切实例都把上一个 iframe 卸载，切回去要重新下一遍前端 bundle、重新挂载、
   * 重新连 WS——用户看到的就是"渲染时间过长"。留着它，远端那套界面连 WS 都没断。
   * 上限 3 台：再多就纯粹是白占内存了。
   */
  const [kept, setKept] = useState<string[]>([])

  const mode = layoutModeOf(store)

  // 配置里开了 collapseSidebar 时，进统一界面顺手把官方侧栏收成窄条——远端 UI 就能拿到整扇窗。
  // 只在"确实还没收起"时点一下；读不到状态就什么都不做（宁可不动，也不要反着切一次）。
  const wantCollapse = collapseSidebarPreferred(store)
  useEffect(() => {
    if (!wantCollapse || mode !== 'immersive' || typeof document === 'undefined') return
    if (document.querySelector('[data-sidebar-collapsed]') !== null) return
    props.layout?.toggleSidebar?.()
  }, [wantCollapse, mode, props.layout])

  // 保活名单：把当前这台排到最前，最多留 KEEP_ALIVE 台；已经停下来的踢出去。
  const activeId = active?.id
  useEffect(() => {
    if (mode !== 'immersive' || activeId === undefined) return
    setKept((current) => {
      const next = [activeId, ...current.filter((id) => id !== activeId)].slice(0, KEEP_ALIVE)
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next
    })
  }, [mode, activeId])

  useEffect(() => {
    setKept((current) => {
      const next = current.filter((id) => {
        const instance = instances.find((entry) => entry.id === id)
        return instance !== undefined && instance.phase === 'running' && instance.mirrorEntryUrl !== undefined
      })
      return next.length === current.length ? current : next
    })
  }, [instances])

  /** 统一界面：远端那套 DSH 的界面铺满主区，我们只剩右下角一条很轻的浮条。 */
  const immersive = (): ReactNode => {
    // 当前这台永远排在保活名单最前面；`kept` 只是"之前看过、先别卸载"的历史。
    // 这样写而不是全塞进 state，是为了**第一次渲染就有镜像**（state 要等 effect 跑完）。
    const keepIds =
      active === undefined
        ? []
        : [active.id, ...kept.filter((id) => id !== active.id)].slice(0, KEEP_ALIVE)
    if (active === undefined) {
      return (
        <div className="drd-root drd-immersive">
          <div className="drd-placeholder">
            <h1 className="drd-title">{DISPLAY_NAME}</h1>
            <div>
              {loading ? '正在读取实例列表…' : '还没有配置实例——先在 profile 的 cordis.patch.yml 里写 instances。'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="drd-btn" onClick={() => setLayoutMode('manage')}>
                打开管理界面
              </button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="drd-root drd-immersive">
        {open === undefined ? (          <div className="drd-placeholder">
            <h1 className="drd-title">{DISPLAY_NAME}</h1>
            <div className="drd-name" style={{ fontSize: 15 }}>
              {shortLabel(active)}｜{shortStatus(active)}
            </div>
            <div className="drd-meta">{active.error ?? active.detail}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="drd-btn"
                data-primary="true"
                disabled={busy !== undefined || active.phase === 'starting'}
                onClick={() => void run(active.id, 'start')}
              >
                {active.phase === 'error' ? '重试启动' : '启动'}
              </button>
              <button type="button" className="drd-btn" onClick={() => setLayoutMode('manage')}>
                管理界面
              </button>
            </div>
          </div>
        ) : (
          <>
            {keepIds.map((id) => {
              const instance = instances.find((entry) => entry.id === id)
              if (instance === undefined || instance.phase !== 'running') return null
              const entryUrl = instance.mirrorEntryUrl
              if (typeof entryUrl !== 'string') return null
              const isActive = id === active.id
              return (
                <div key={id} className="drd-keep" data-active={isActive} hidden={!isActive}>
                  <MirrorStage
                    key={`${id}:${String(reloads[id] ?? 0)}`}
                    entryUrl={entryUrl}
                    label={instance.label}
                    preference={preference}
                    services={props}
                    floatingNote={true}
                    {...(isActive
                      ? {
                          onNote: (value: string) => {
                            carrierNoteRef.current = value
                          },
                        }
                      : {})}
                  />
                </div>
              )
            })}
            <div className="drd-float">
              <span className="drd-dot" data-phase={active.phase} />
              <span className="drd-name" title={longStatus(active)}>
                {shortLabel(active)}
              </span>
              <span className="drd-meta">{shortStatus(active)}</span>
              <button
                type="button"
                className="drd-btn"
                title={sidebarCollapsed() ? '展开应用侧栏' : '收起应用侧栏，让这台机器的界面占满窗口'}
                onClick={toggleSidebar}
              >
                全窗口
              </button>
              <button
                type="button"
                className="drd-btn"
                title="把这台机器的镜像载体重新挂一遍（卡住、或想重走一遍票据时用）"
                onClick={() =>
                  setReloads((current) => ({ ...current, [active.id]: (current[active.id] ?? 0) + 1 }))
                }
              >
                重载
              </button>
              <button
                type="button"
                className="drd-btn"
                title="显示实例列表、工具栏与日志"
                onClick={() => setLayoutMode('manage')}
              >
                管理
              </button>
            </div>
          </>
        )}
        {busy !== undefined ? <div className="drd-float-note">正在{active.phase === 'starting' ? '启动' : '处理'}…</div> : null}
      </div>
    )
  }

  // 统一界面：把远端那套 DSH 的界面铺满主区，列表 / 工具栏 / 日志都收起来。
  if (mode === 'immersive') return immersive()

  return (
    <div className="drd-root">
      <div className="drd-bar">
        <h1 className="drd-title">{DISPLAY_NAME}</h1>
        <span className="drd-badge">{instances.length === 0 ? '未配置实例' : `${String(instances.length)} 个实例`}</span>
        <div className="drd-spacer" />
        <button
          type="button"
          className="drd-btn"
          title="回到统一界面：选中的那台机器的 DSH 界面铺满主区，只留一条很轻的浮条"
          onClick={() => setLayoutMode('immersive')}
        >
          统一界面
        </button>
        <button
          type="button"
          className="drd-btn"
          title="把能力矩阵、每个实例的状态与版本、当前容器说明和日志尾部攒成一段文本，方便贴给别人排查"
          onClick={() => void collectDiagnostics()}
        >
          复制诊断
        </button>
        <button type="button" className="drd-btn" onClick={() => actions.refresh()}>
          刷新
        </button>
      </div>

      {diagnostics === undefined ? null : (
        <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1, currentColor)' }}>
          <div className="drd-meta" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{diagnosticsNote}</span>
            <button type="button" className="drd-btn" onClick={() => setDiagnostics(undefined)}>
              关闭
            </button>
          </div>
          <textarea
            readOnly
            value={diagnostics}
            onFocus={(event) => event.currentTarget.select()}
            style={{
              width: '100%',
              height: 160,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              background: 'var(--dsw-alias-bg-layer-1, transparent)',
              color: 'inherit',
              border: '1px solid var(--dsw-alias-border-l1, currentColor)',
              borderRadius: 6,
              padding: 8,
            }}
          />
        </div>
      )}

      {instancesError === undefined ? null : <div className="drd-error">控制接口报错：{instancesError}</div>}

      <div className="drd-body">
        <div className="drd-list">
          <InstanceList instances={instances} activeId={active?.id} onSelect={actions.select} loading={loading} />
        </div>

        <div className="drd-main">
          {active === undefined ? (
            <div className="drd-placeholder">
              {loading ? '正在读取实例列表…' : '左侧还没有实例。'}
            </div>
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
                  void checkInstance(id).then((result) => {
                    setChecks(
                      result.ok
                        ? { phase: 'ready', items: result.checks }
                        : { phase: 'error', message: result.message ?? '预检失败' },
                    )
                  })
                }}
              />

              {checks === undefined ? null : <CheckList state={checks} onClose={() => setChecks(undefined)} />}

              {open === undefined ? (
                <div className="drd-placeholder">
                  {active.phase === 'running' ? '正在准备镜像端点…' : '实例未运行。点「启动」后这里会显示它的完整界面。'}
                </div>
              ) : (
                <MirrorStage
                  entryUrl={open}
                  label={active.label}
                  preference={preference}
                  services={props}
                  onNote={(value) => {
                    carrierNoteRef.current = value
                  }}
                />
              )}

              <LogDrawer lines={logs.lines} onClear={logs.clear} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 面板的接线层：把共享状态与动作接到纯渲染的 `PanelView` 上。 */
function Panel(services: PanelServices): ReactNode {
  const store = useWorkbenchStore()
  const actions: PanelActions = {
    refresh: () => void refreshWorkbench(),
    select: (id) => selectInstance(id),
    lifecycle: (id, action) => lifecycleAction(id, action),
    version: (id, action) => versionAction(id, action),
  }
  return <PanelView {...services} store={store} actions={actions} />
}

/* ── 窗口角上的「本机 / WSL」切换下拉框 ── */

/** 切换器偏好（来自 `config.switcher`）。 */
export type SwitcherCorner = 'top-center' | 'top-right' | 'top-left'

export interface SwitcherPreference {
  enabled: boolean
  corner: SwitcherCorner
  offsetX: number
  /** 留空 = 跟随官方 `--dsh-frame-overlay-top`。 */
  offsetY?: number
}

// 默认贴**上边中间**：右上角会压到官方的侧栏开关与面板自己的按钮，左上角是窗口菜单。
const SWITCHER_DEFAULT: SwitcherPreference = { enabled: true, corner: 'top-center', offsetX: 56 }

function switcherPreference(report: HostReport | undefined): SwitcherPreference {
  const raw = (report?.config as { switcher?: unknown } | undefined)?.switcher
  if (raw === undefined || raw === null || typeof raw !== 'object') return SWITCHER_DEFAULT
  const value = raw as Partial<SwitcherPreference>
  const corner: SwitcherCorner =
    value.corner === 'top-left' || value.corner === 'top-right' ? value.corner : 'top-center'
  return {
    enabled: value.enabled !== false,
    corner,
    offsetX: typeof value.offsetX === 'number' ? value.offsetX : SWITCHER_DEFAULT.offsetX,
    ...(typeof value.offsetY === 'number' ? { offsetY: value.offsetY } : {}),
  }
}

/**
 * 摆位：**优先躲进窗口标题栏那一条**。
 *
 * 起因是实测：桌面版里 `--dsh-frame-overlay-top`（标题栏高度 + 20px）正好落在会话表头那一行，
 * 于是切换器压住了「会话标题 / 对话·轨迹」这些字。而标题栏那一条本身在**中间是空的**
 * （左边是窗口菜单、右边是三个窗口按钮），把切换器放进那条带子里，就谁也不挡了。
 *
 * 判断"有没有标题栏"用官方自己的 token `--dsh-frame-top-clearance`（桌面版 = 标题栏高度，
 * 纯 Web 外壳没有这个值）——不写死平台，也不猜类名。
 *
 * 位置每次都**现算**，并且监听窗口尺寸变化：窗口一改，它跟着重新居中/重新贴边。
 */
function useSwitcherPlacement(
  config: SwitcherPreference,
  rootRef: { current: HTMLDivElement | null },
  visible: boolean,
): { band: 'chrome' | 'content'; y: number | undefined; x: number | undefined } {
  const [placement, setPlacement] = useState<{ band: 'chrome' | 'content'; y: number | undefined; x: number | undefined }>(
    { band: 'content', y: config.offsetY, x: config.offsetX },
  )

  useEffect(() => {
    if (typeof document === 'undefined' || !visible) return
    const measure = (): void => {
      const styles = getComputedStyle(document.documentElement)
      const clearance = Number.parseFloat(styles.getPropertyValue('--dsh-frame-top-clearance')) || 0
      const root = rootRef.current
      const height = root === null ? 28 : root.getBoundingClientRect().height || 28
      const corner = config.corner
      // 有标题栏：钻进那条带子，垂直居中在带子里（离顶至少留 4px）。
      const band = clearance >= 8 && corner === 'top-center' ? 'chrome' : 'content'
      const y =
        config.offsetY !== undefined
          ? config.offsetY
          : band === 'chrome'
            ? Math.max(4, Math.round((clearance - height) / 2))
            : undefined
      setPlacement((current) =>
        current.band === band && current.y === y && current.x === config.offsetX
          ? current
          : { band, y, x: config.offsetX },
      )
      // 标题栏那一条里躺着的时候，本面板表头就不需要让位了。
      if (band === 'chrome' || corner !== 'top-right') {
        document.documentElement.style.removeProperty('--drd-switch-reserve')
      }
    }
    measure()
    // 窗口尺寸 / 侧栏收放 / 全屏切换都会改这套几何，所以三处都听：
    // resize 事件、body 的尺寸观察，以及 html 上那几个官方标记属性（标题栏 / 全屏）。
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    if (observer !== undefined) observer.observe(document.body)
    const attributeWatcher =
      typeof MutationObserver === 'function'
        ? new MutationObserver(measure)
        : undefined
    attributeWatcher?.observe(document.documentElement, {
      attributes: true,
      // 只盯这几个（别盯 style：我们自己就在 html 上写 --drd-* 变量，会自激）。
      attributeFilter: ['data-windows-titlebar', 'data-fullscreen', 'data-platform'],
    })
    const timer = window.setInterval(measure, 1000)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
      attributeWatcher?.disconnect()
      window.clearInterval(timer)
    }
  }, [visible, config.corner, config.offsetX, config.offsetY, rootRef])

  return placement
}
/**
 * 把切换器实测宽度写进 `--drd-switch-reserve`，让本面板的表头与工具栏让出这段宽度。
 *
 * 浮层压住别人家的按钮是可以接受的（那本来就是个浮层），但压住**自己面板**的按钮就不行——
 * 而右上角恰好就是我们放「复制诊断 / 刷新」的地方。量一次比写死一个魔法数字靠谱。
 *
 * `visible` 必须进依赖：第一次渲染时实例列表还没回来，组件返回 null（DOM 里没有那个节点），
 * 只在挂载那一刻量一次会永远量不到东西。
 */
function useReserveSpace(
  config: SwitcherPreference,
  rootRef: { current: HTMLDivElement | null },
  visible: boolean,
): void {
  useEffect(() => {
    if (typeof document === 'undefined' || !visible) return
    // 只有贴右上角才需要面板让位；中间那条压在表头空白处，本来就不挡按钮。
    if (config.corner !== 'top-right') {
      document.documentElement.style.removeProperty('--drd-switch-reserve')
      return
    }
    const root = rootRef.current
    if (root === null) return
    const publish = (): void => {
      const width = root.getBoundingClientRect().width
      if (width <= 0) return
      document.documentElement.style.setProperty(
        '--drd-switch-reserve',
        `${String(Math.round(config.offsetX + width + 12))}px`,
      )
    }
    publish()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : undefined
    observer?.observe(root)
    window.addEventListener('resize', publish)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', publish)
      document.documentElement.style.removeProperty('--drd-switch-reserve')
    }
  }, [visible, config.offsetX, config.corner, rootRef])
}

/**
 * 切换器本体：**纯渲染**。
 *
 * 选中某一项 = ①记下选中 ②把它跑起来（本机那一项是吸附，不拉新进程）③把主区切到本面板，
 * 于是"选 WSL 就连 WSL 的服务端口"这件事在一次点击里完成。
 */
export function WorkbenchSwitcherView({
  store,
  actions,
  services,
  preference,
}: {
  store: WorkbenchStore
  actions: Pick<PanelActions, 'select'>
  services: PanelServices
  preference?: SwitcherPreference
}): ReactNode {
  const config = preference ?? switcherPreference(store.host.phase === 'ready' ? store.host.value : undefined)
  const instances = store.instances.phase === 'ready' ? store.instances.value : []
  const active = activeInstance(store)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const visible = config.enabled && instances.length > 0 && active !== undefined
  const placement = useSwitcherPlacement(config, rootRef, visible)
  useReserveSpace(config, rootRef, visible && placement.band === 'content')

  if (!visible || active === undefined) return null

  const onChange = (id: string): void => {
    actions.select(id)
    // 主区切到本面板：选谁就看谁，不用再去侧栏点一次。
    services.layout?.selectPanel(PANEL_ID)
    setBusy(true)
    void ensureRunning(id)
      .then((result) => {
        setNote(result.ok ? '' : (result.message ?? '启动失败'))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div
      ref={rootRef}
      className="drd-switch"
      data-corner={config.corner}
      data-band={placement.band}
      style={
        {
          '--drd-switch-x': `${String(placement.x ?? config.offsetX)}px`,
          ...(placement.y === undefined ? {} : { '--drd-switch-y': `${String(placement.y)}px` }),
        } as CSSProperties
      }
      title="切换要显示哪一台机器上的 DSH（本机 / WSL / 虚拟机 / 远程）"
    >
      <span className="drd-dot" data-phase={active.phase} />
      <select
        value={active.id}
        disabled={busy}
        aria-label="选择要连接的 DSH"
        title={longStatus(active)}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {instances.map((instance) => (
          <option key={instance.id} value={instance.id} title={longStatus(instance)}>
            {shortLabel(instance)}
          </option>
        ))}
      </select>
      {/* 只留关键字：完整说明（端口、吸附、错误原因）在悬停提示里。 */}
      <span className="drd-meta" title={longStatus(active)}>
        {busy ? '连接中' : note !== '' ? '失败' : shortStatus(active)}
      </span>
      {note === '' ? null : (
        <span className="drd-meta" style={{ color: 'var(--dsw-alias-state-error-primary, inherit)' }} title={note}>
          {note.slice(0, 60)}
        </span>
      )}
    </div>
  )
}

/** 切换器的接线层（注册进 `shell.overlay`）。 */
function WorkbenchSwitcher(services: PanelServices): ReactNode {
  const store = useWorkbenchStore()
  return (
    <WorkbenchSwitcherView
      store={store}
      actions={{ select: (id) => selectInstance(id) }}
      services={services}
    />
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
        <Row label="宿主自身端点">
          <span className="drd-mono">
            {report.host.webPort === null || report.host.webPort === undefined
              ? '未知（本机实例无法吸附）'
              : `127.0.0.1:${String(report.host.webPort)} ｜ 可吸附：${report.host.selfAttachable === true ? '是' : '否'}`}
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
  const store = useWorkbenchStore()
  const host = store.host
  return (
    <div className="drd-root">
      <div className="drd-bar">
        <h1 className="drd-title">{DISPLAY_NAME} · 设置</h1>
        <div className="drd-spacer" />
        <button type="button" className="drd-btn" onClick={() => void refreshWorkbench()}>
          重新探测
        </button>
      </div>
      <div className="drd-scroll">
        {host.phase === 'error' ? <div className="drd-error">读取宿主状态失败：{host.message}</div> : null}
        {host.phase === 'ready' ? <CapabilityCard report={host.value} /> : null}
        <div className="drd-card">
          <h3>配置示例</h3>
          <pre className="drd-mono">{`- id: remote-desks
  config:
    instances:
      - id: local-dev        # 本机：桌面版内置运行时，默认吸附（不另起进程）
        kind: local
        label: 本机           # 下拉框里的关键字（括注会被去掉）
        # attach: true       # 强制吸附；attach: false 则照样自己拉一份
      - id: wsl-ubuntu
        kind: wsl
        label: WSL · Ubuntu-24.04
        distro: Ubuntu-24.04
        cwd: /home/you/project
      - id: vm-ubuntu        # 虚拟机 / 远程主机都走 ssh，不用新的 kind
        kind: ssh
        label: 虚拟机 Ubuntu
        host: 192.168.64.7
        username: dev
        auth: { method: privateKey, privateKeyPath: C:\\Users\\you\\.ssh\\id_ed25519 }
    switcher:
      enabled: true          # 窗口角上的机器切换下拉框
      corner: top-right      # top-right | top-left
      offsetX: 56
      # offsetY 留空 = 跟官方 --dsh-frame-overlay-top
    layout:
      mode: immersive        # immersive 统一界面（默认）｜ manage 管理界面
      collapseSidebar: false # true = 进统一界面时顺手把官方侧栏收成窄条`}</pre>
          <p className="drd-meta">
            统一界面 = 选中那台机器的 DSH 界面铺满主区（和 WebUI 同一套 UI 与体验），我们自己的列表 /
            工具栏 / 日志收在「管理」里；两种形态随时互切，选择记在本地。
          </p>
          <p className="drd-meta">
            本机（<span className="drd-mono">kind: local</span>）实例在桌面版里默认**吸附**宿主自己那套
            DSH——它本来就在跑，所以打开应用就是「运行中」；要另起一份独立进程就写
            <span className="drd-mono"> attach: false</span>。
          </p>
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
 * 客户端入口：注册面板入口、主面板、设置页，以及窗口角上的「本机 / WSL」切换器。
 *
 * 四处注册都用 `ctx.slots.inject`，因此不依赖声明顺序——对应 slot 一出现就会挂上。
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

  // 窗口角上的切换下拉框。
  //
  // 落点是 `shell.overlay`：官方把它描述为"帧级浮层、压在所有列之上、且是**增量**座位"——
  // 新 id 会加在既有条目旁边而不是顶掉它们（`shell.leading` 那种 single 座位会被顶掉，
  // 而且只在侧栏完全收起时才挂载，不适合常驻）。浮层本身点击穿透，所以组件自己接回指针事件。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: SWITCHER_ID,
        order: 40,
        label: () => DISPLAY_NAME,
        inject: () => ({ layout: ctx.layout }),
      },
      WorkbenchSwitcher as never,
    ),
  )
}

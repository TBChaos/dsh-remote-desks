import { useCallback, useEffect, useState, type ReactNode } from 'react'

/** 与 host 半共享的面板 id：sidebar 入口与 main 面板用同一个值。 */
export const PANEL_ID = 'remote-desks'
/** 控制接口前缀，与 host 半的 CONTROL_PREFIX 保持一致。 */
export const CONTROL_PREFIX = '/remote-desks'
/** 展示名（中文优先）。 */
export const DISPLAY_NAME = '远端工作台'

const STYLE_MARKER = 'dsh-remote-desks/client.css'

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

interface ClientContext {
  slots: SlotsService
  get?(key: string): unknown
  layout?: { selectPanel(panelId: string | null): void }
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

/* ── 样式：只注入一次，使用官方主题 token，不写死颜色 ── */

const CSS = `
.drd-root { height: 100%; min-height: 0; overflow: auto; padding: 24px 28px 32px;
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-base, transparent);
  font-size: 14px; line-height: 1.6; }
.drd-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.drd-title { font-size: 18px; font-weight: 600; margin: 0; }
.drd-badge { font-size: 12px; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor); color: var(--dsw-alias-label-secondary, inherit); }
.drd-sub { color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; margin: 6px 0 18px; }
.drd-card { border: 1px solid var(--dsw-alias-border-l1, currentColor); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent); padding: 14px 16px; margin-bottom: 14px; }
.drd-card h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.drd-grid { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 16px; }
.drd-key { color: var(--dsw-alias-label-secondary, inherit); }
.drd-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
  word-break: break-all; }
.drd-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.drd-chip { font-size: 12px; padding: 1px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor); }
.drd-chip[data-on="true"] { color: var(--dsw-alias-state-success-primary, inherit); }
.drd-chip[data-on="false"] { color: var(--dsw-alias-state-idle-primary, inherit); }
.drd-empty { border: 1px dashed var(--dsw-alias-border-l2, currentColor); border-radius: 10px;
  padding: 22px; text-align: center; color: var(--dsw-alias-label-secondary, inherit); }
.drd-error { border: 1px solid var(--dsw-alias-state-error-primary, currentColor); border-radius: 10px;
  padding: 12px 14px; color: var(--dsw-alias-state-error-primary, inherit); }
.drd-actions { display: flex; gap: 8px; margin-left: auto; }
.drd-btn { font: inherit; font-size: 13px; padding: 3px 12px; border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, transparent);
  border: 1px solid var(--dsw-alias-border-l1, currentColor); }
.drd-btn:hover { border-color: var(--dsw-alias-border-l2, currentColor); }
.drd-note { color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; }
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

type FetchState =
  | { phase: 'loading' }
  | { phase: 'ready'; report: HostReport }
  | { phase: 'error'; message: string }

const STATE_URL = `${CONTROL_PREFIX}/api/state`

function useHostReport(): { state: FetchState; reload: () => void } {
  const [state, setState] = useState<FetchState>({ phase: 'loading' })
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
      .then((report) => {
        if (alive) setState({ phase: 'ready', report })
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

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { state, reload }
}

/* ── 组件 ── */

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
        <Row label="运行形态">
          {desktop ? '桌面版（Electron 外壳）' : '纯 Web 版（浏览器外壳）'}
        </Row>
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
        <Row label="配置实例">
          {report.config.instances} 个（启用 {report.config.enabledInstances}，自动启动 {report.config.autoStart}）
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

function Panel(): ReactNode {
  const { state, reload } = useHostReport()

  return (
    <div className="drd-root">
      <div className="drd-head">
        <h1 className="drd-title">{DISPLAY_NAME}</h1>
        <span className="drd-badge">{state.phase === 'ready' ? state.report.plugin.milestone : 'M0'}</span>
        <div className="drd-actions">
          <button type="button" className="drd-btn" onClick={reload}>
            刷新
          </button>
        </div>
      </div>
      <p className="drd-sub">
        把本机 / WSL / 远端的 DSH 镜像到当前界面。M0 只做骨架与能力探测，不启动任何进程。
      </p>

      {state.phase === 'error' ? (
        <div className="drd-error">
          读取宿主状态失败：{state.message}
          <br />
          <span className="drd-mono">GET {STATE_URL}</span>
        </div>
      ) : null}

      {state.phase === 'ready' ? <CapabilityCard report={state.report} /> : null}

      <div className="drd-card">
        <h3>实例</h3>
        {state.phase === 'ready' && state.report.config.instances === 0 ? (
          <div className="drd-empty">
            还没有配置实例。
            <br />
            M1 会在这里列出实例，并提供「启动 / 停止 / 打开镜像」，支持多实例同时在线与标签切换。
          </div>
        ) : (
          <p className="drd-note">实例列表将在 M1 接入。</p>
        )}
      </div>
    </div>
  )
}

function SettingsSection(): ReactNode {
  const { state, reload } = useHostReport()
  return (
    <div className="drd-root">
      <div className="drd-head">
        <h1 className="drd-title">{DISPLAY_NAME} · 设置</h1>
        <div className="drd-actions">
          <button type="button" className="drd-btn" onClick={reload}>
            重新探测
          </button>
        </div>
      </div>
      <p className="drd-sub">插件在 profile 的 cordis.patch.yml 里声明实例；M1 起可以在本页直接增删改。</p>
      {state.phase === 'error' ? <div className="drd-error">读取宿主状态失败：{state.message}</div> : null}
      {state.phase === 'ready' ? <CapabilityCard report={state.report} /> : null}
      <div className="drd-card">
        <h3>配置示例</h3>
        <pre className="drd-mono">{`- id: remote-desks
  name: dsh-remote-desks
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
    ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel as never),
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: PANEL_ID, order: 60, label: () => DISPLAY_NAME },
      SettingsSection as never,
    ),
  )
}

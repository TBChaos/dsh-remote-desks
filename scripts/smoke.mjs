// 载入期冒烟测试：直接跑真实产物，而不是重新实现一遍。
//
// 覆盖三件事：
//   1. host 半能导入，且 Config 能把空配置补全成默认值；
//   2. host 半注册的路由真的能被调用：回环请求 200、非回环 403、未知路径 404；
//   3. 客户端 bundle 是真能加载的 classic script：在 vm 里喂假的
//      window.__ModuleLoader__ 与 require，取回工厂并调用 apply()，断言它挂上了三个 slot。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(text) {
      this.body = typeof text === 'string' ? text : ''
    },
  }
}

/* ── 1. host 半 ── */

console.log('\n[1] host 半（lib/index.js）')
const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
check('导出 name', host.name === 'dsh-remote-desks', String(host.name))
check('导出 apply', typeof host.apply === 'function')
check('导出 Config', typeof host.Config === 'function')
check('导出 inject 且声明 webServer', Array.isArray(host.inject) && host.inject.includes('webServer'), JSON.stringify(host.inject))

const defaults = host.Config({})
check('空配置补全 instances', Array.isArray(defaults.instances) && defaults.instances.length === 0)
check('空配置补全 autoStart', Array.isArray(defaults.autoStart))
check('空配置补全 mirror.openMode', defaults.mirror?.openMode === 'auto', String(defaults.mirror?.openMode))
check('空配置补全 mirror.portRange', Array.isArray(defaults.mirror?.portRange))
check(
  '空配置补全 switcher（默认上边中间，不挡图标）',
  defaults.switcher?.enabled === true && defaults.switcher?.corner === 'top-center',
  JSON.stringify(defaults.switcher),
)
const withInstance = host.Config({
  instances: [{ id: 'demo', kind: 'local' }],
})
check('实例默认 enabled', withInstance.instances[0]?.enabled === true)
check('实例默认 jumpHosts', Array.isArray(withInstance.instances[0]?.jumpHosts))
check('实例默认 auth.method=agent', withInstance.instances[0]?.auth?.method === 'agent', String(withInstance.instances[0]?.auth?.method))
check('实例默认不写 attach（自动判定）', withInstance.instances[0]?.attach === undefined)
const attachedConfig = host.Config({ instances: [{ id: 'demo', kind: 'local', attach: true }] })
check('attach: true 被接受', attachedConfig.instances[0]?.attach === true)
const detachedConfig = host.Config({ instances: [{ id: 'demo', kind: 'local', attach: false }] })
check('attach: false 被接受', detachedConfig.instances[0]?.attach === false)
const switcherConfig = host.Config({ switcher: { corner: 'top-left', offsetX: 8, offsetY: 8 } })
check('switcher 可配置', switcherConfig.switcher.corner === 'top-left' && switcherConfig.switcher.offsetX === 8 && switcherConfig.switcher.enabled === true, JSON.stringify(switcherConfig.switcher))
let badCornerRejected = false
try {
  host.Config({ switcher: { corner: 'middle' } })
} catch {
  badCornerRejected = true
}
check('非法 corner 被拒绝', badCornerRejected)
const sshInstance = host.Config({ instances: [{ id: 'x', kind: 'ssh', host: 'h', username: 'u' }] })
check('ssh 实例解析 host', sshInstance.instances[0]?.host === 'h')
let badKindRejected = false
try {
  host.Config({ instances: [{ id: 'x', kind: 'nope' }] })
} catch {
  badKindRejected = true
}
check('非法 kind 被拒绝', badKindRejected)
let missingIdRejected = false
try {
  host.Config({ instances: [{ kind: 'local' }] })
} catch {
  missingIdRejected = true
}
check('缺 id 被拒绝', missingIdRejected)

/* ── 2. 控制路由 ── */

console.log('\n[2] 控制路由（真实 handler + 伪造请求）')
const routes = []
const effects = []
const logs = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  logger: {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  },
  effect(callback, label) {
    effects.push(label)
    callback()
    return () => {}
  },
  get() {
    return undefined
  },
}

host.apply(ctx, host.Config({}))

check('注册了一条路由', routes.length === 1, `实际 ${routes.length}`)
const route = routes[0]
check('路由是 prefix', route?.kind === 'prefix', String(route?.kind))
check('路由前缀正确', route?.path === '/remote-desks', String(route?.path))
check('已声明 effect 标签', effects.includes('dsh-remote-desks: control routes'))
check('写了一条就绪日志', logs.some(([level]) => level === 'info'))

const handler = route?.handler
const call = (method, url, headers) => {
  const res = fakeResponse()
  handler({ method, url, headers }, res)
  return res
}

const okState = call('GET', '/remote-desks/api/state', { host: '127.0.0.1:19387' })
check('回环 GET /api/state → 200', okState.statusCode === 200, String(okState.statusCode))
const parsed = (() => {
  try {
    return JSON.parse(okState.body)
  } catch {
    return undefined
  }
})()
check('状态体是合法 JSON', parsed !== undefined)
check('状态体带 plugin.milestone', typeof parsed?.plugin?.milestone === 'string', String(parsed?.plugin?.milestone))
check('状态体带 runtime 探测结果', typeof parsed?.runtime?.found === 'boolean')
check('状态体列出服务可用性', typeof parsed?.services?.webServer === 'boolean')
check('闸门记录了落点', typeof parsed?.control?.gate === 'string', String(parsed?.control?.gate))

const ipv6State = call('GET', '/remote-desks/api/state', { host: '[::1]:19387' })
check('IPv6 回环放行', ipv6State.statusCode === 200, String(ipv6State.statusCode))

const lanState = call('GET', '/remote-desks/api/state', { host: '192.168.1.20:19387' })
check('非回环 Host → 403', lanState.statusCode === 403, String(lanState.statusCode))

const crossOrigin = call('GET', '/remote-desks/api/state', {
  host: '127.0.0.1:19387',
  origin: 'http://evil.example',
})
check('跨站 Origin → 403', crossOrigin.statusCode === 403, String(crossOrigin.statusCode))

const sameOrigin = call('GET', '/remote-desks/api/state', {
  host: '127.0.0.1:19387',
  origin: 'http://127.0.0.1:19387',
})
check('同源 Origin 放行', sameOrigin.statusCode === 200, String(sameOrigin.statusCode))

const ping = call('GET', '/remote-desks/api/ping', { host: '127.0.0.1:19387' })
check('GET /api/ping → 200', ping.statusCode === 200, String(ping.statusCode))

const missing = call('GET', '/remote-desks/api/nope', { host: '127.0.0.1:19387' })
check('未知路径 → 404', missing.statusCode === 404, String(missing.statusCode))

const wrongMethod = call('POST', '/remote-desks/api/state', { host: '127.0.0.1:19387' })
check('非 GET 方法 → 404', wrongMethod.statusCode === 404, String(wrongMethod.statusCode))

const noHost = call('GET', '/remote-desks/api/state', {})
check('缺 Host → 403', noHost.statusCode === 403, String(noHost.statusCode))

/* ── 2b. 叠加上官方信任判定 ── */

console.log('\n[2b] 闸门叠加（官方 requestRejection + 回环）')
const seenByOfficial = []
const officialContext = {
  ...ctx,
  get(key) {
    if (key !== 'connection') return undefined
    return {
      requestRejection(request) {
        seenByOfficial.push(request.headers.host)
        return request.headers.host === 'blocked.example:1' ? 401 : undefined
      },
    }
  },
}
host.apply(officialContext, host.Config({}))
const layered = routes[routes.length - 1]?.handler
const callLayered = (headers) => {
  const res = fakeResponse()
  layered({ method: 'GET', url: '/remote-desks/api/state', headers }, res)
  return res
}

check('官方放行 + 回环 → 200', callLayered({ host: '127.0.0.1:19387' }).statusCode === 200)
check('官方判定确实被调用', seenByOfficial.includes('127.0.0.1:19387'), JSON.stringify(seenByOfficial))
check('官方拒绝 → 401', callLayered({ host: 'blocked.example:1' }).statusCode === 401)
check(
  '官方放行但不回环 → 仍 403',
  callLayered({ host: '10.0.0.5:19387' }).statusCode === 403,
  String(callLayered({ host: '10.0.0.5:19387' }).statusCode),
)
const layeredState = callLayered({ host: '127.0.0.1:19387' })
const layeredReport = JSON.parse(layeredState.body)
check(
  '闸门描述反映叠加',
  typeof layeredReport?.control?.gate === 'string' && layeredReport.control.gate.includes('requestRejection'),
  String(layeredReport?.control?.gate),
)
const plainGate = JSON.parse(call('GET', '/remote-desks/api/state', { host: '127.0.0.1:19387' }).body)
check(
  '无官方服务时闸门描述为回环',
  plainGate?.control?.gate === 'loopback-guard',
  String(plainGate?.control?.gate),
)

/* ── 3. 客户端 bundle ── */

console.log('\n[3] 客户端 bundle（lib/client.js）')
const source = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
check('使用 __ModuleLoader__.load', source.includes('window.__ModuleLoader__.load({'))
check('模块 id 是包名', source.includes('"dsh-remote-desks"'))
check('只 require 基线模块', !/require\("(?!react|react\/jsx-runtime|react-dom|react-dom\/client")/.test(source))

const jsxRuntime = {
  jsx: () => null,
  jsxs: () => null,
  Fragment: Symbol('Fragment'),
}
const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  createElement: () => null,
}
const load = { id: undefined, factory: undefined }
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        load.id = definition.id
        load.factory = definition.factory
      },
    },
  },
  console,
}
const requireStub = (request) => {
  if (request === 'react') return reactStub
  if (request === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`客户端 bundle 请求了基线之外的模块：${request}`)
}

vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
check('加载时登记了模块 id', load.id === 'dsh-remote-desks', String(load.id))
check('登记了 factory', typeof load.factory === 'function')

const clientExports = load.factory(requireStub)
check('客户端导出 apply', typeof clientExports.apply === 'function')
check('客户端导出 inject([slots])', Array.isArray(clientExports.inject) && clientExports.inject.includes('slots'))

const registered = []
const injected = []
const clientCtx = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      callback()
      return () => {}
    },
    register(options) {
      registered.push(options)
      return () => {}
    },
  },
}
clientExports.apply(clientCtx)
check('注入了 sidebar.panellist', injected.includes('sidebar.panellist'))
check('注入了 main', injected.includes('main'))
check('注入了 settings.section', injected.includes('settings.section'))

const panelEntry = registered.find((options) => options.name === 'sidebar.panellist')
check('sidebar 入口 id 与面板 key 一致', panelEntry?.id === 'remote-desks', String(panelEntry?.id))
const mainPanel = registered.find((options) => options.name === 'main')
check('注册了 main 面板 key', mainPanel?.key === 'remote-desks', String(mainPanel?.key))
check('sidebar 入口带中文标签', typeof panelEntry?.label === 'function' && panelEntry.label() === '远端工作台')
check('注册总数=4', registered.length === 4, `实际 ${registered.length}`)
const switcherEntry = registered.find((options) => options.name === 'shell.overlay')
check('注册了窗口角上的切换器（shell.overlay）', switcherEntry !== undefined)
check(
  '切换器用独立 id（增量座位，不顶掉官方条目）',
  switcherEntry?.id === 'remote-desks.switcher',
  String(switcherEntry?.id),
)
check('注入了 shell.overlay', injected.includes('shell.overlay'))

// 面板与控制接口/镜像容器链路的接线（静态检查，防回归）
check('面板调用实例列表接口', source.includes('/api/instances'))
check('容器链含桌面 webview lease', source.includes('dshDesktop') && source.includes('about:blank#'))
check('容器链含 iframe 兜底', source.includes('iframe'))
check('容器链含系统浏览器兜底', source.includes('_blank'))
check('容器链含官方右栏载体', source.includes('openTab') && source.includes('openRightbar'))
check('容器偏好读取配置', source.includes('openMode'))
// 抖动回归：dom-ready 对每次导航都触发，早先"每次 dom-ready 都重设 src"会变成无限重载。
// 注意：bundle 里非 ASCII 会被 esbuild 转义（默认 charset=ascii），所以这里按标识符断言，
// 不按中文文案断言。
check('webview 导航只做一次（有 navigated 闸门）', /navigated/.test(source) && /if \(disposed \|\| navigated\) return/.test(source))
check('导航后另有超时兜底', source.includes('postNavWatchdog'))
check('guest 是空的会被探测到', source.includes('childElementCount'))
check(
  '载体会自动降级成内嵌框架',
  (source.match(/setMode\(.iframe.\)/g) ?? []).length >= 3,
  String((source.match(/setMode\(.iframe.\)/g) ?? []).length),
)
check('窗口角上有切换下拉框', source.includes('shell.overlay') && source.includes('drd-switch'))
check(
  '切换器会钻进窗口标题栏那一条（有标题栏时）',
  source.includes('dsh-frame-top-clearance') && source.includes('useSwitcherPlacement') && /data-band/.test(source),
)
check('标题栏里可点（不是拖动区吞掉点击）', source.includes('-webkit-app-region') && source.includes('no-drag'))
check('窗口尺寸变化会重算位置', source.includes("addEventListener(\"resize\"") || source.includes("addEventListener('resize'"))
check('切换器与面板共用选中状态', source.includes('selectInstance') && source.includes('activeInstance'))
check('客户端认识吸附标记', /attached ={2,3} true/.test(source))
check('共享 store 只在有订阅者时轮询', source.includes('subscribeWorkbench') && source.includes('startPolling'))
// partition 必须在 src 之前设置：它得在首次导航前就位。
const attrAt = (name) => {
  const single = source.indexOf(`'${name}'`)
  const double = source.indexOf(`"${name}"`)
  if (single === -1) return double
  if (double === -1) return single
  return Math.min(single, double)
}
check(
  'webview 先设 partition 再设 src',
  attrAt('partition') !== -1 && attrAt('src') !== -1 && attrAt('partition') < attrAt('src'),
  `partition@${String(attrAt('partition'))} src@${String(attrAt('src'))}`,
)
check('面板引用了生命周期动作', source.includes('restart') && source.includes('start') && source.includes('stop'))
check('面板有预检入口', source.includes('/check'))

/* ── 4. 头重写规则（纯函数，最易悄悄回归） ── */

console.log('\n[4] 镜像代理的头重写')
const rewrite = await import(pathToFileURL(resolve(root, 'lib/mirror/rewrite.js')).href)

const requestHeaders = rewrite.rewriteRequestHeaders(
  {
    host: '127.0.0.1:52480',
    origin: 'http://127.0.0.1:52480',
    cookie: 'dsh_mirror=abc; other=1',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    connection: 'keep-alive',
    'accept-encoding': 'gzip',
    'user-agent': 'test',
  },
  '127.0.0.1:52478',
  'dsh-auth-xyz=v1.token',
)
check('请求 host 改写为上游', requestHeaders.host === '127.0.0.1:52478', String(requestHeaders.host))
check('请求 origin 改写为上游', requestHeaders.origin === 'http://127.0.0.1:52478', String(requestHeaders.origin))
check('注入远端 cookie（不泄漏票据）', requestHeaders.cookie === 'dsh-auth-xyz=v1.token', String(requestHeaders.cookie))
check('剥离 sec-fetch-*', requestHeaders['sec-fetch-site'] === undefined && requestHeaders['sec-fetch-mode'] === undefined)
check('逐跳头被剥掉', requestHeaders.connection === 'close', String(requestHeaders.connection))
check('普通头保留', requestHeaders['accept-encoding'] === 'gzip' && requestHeaders['user-agent'] === 'test')

const wsHeaders = rewrite.rewriteRequestHeaders(
  { host: 'x', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'k', 'sec-websocket-version': '13' },
  '127.0.0.1:1',
  undefined,
  { websocket: true },
)
check('WebSocket 保留 upgrade', wsHeaders.upgrade === 'websocket', String(wsHeaders.upgrade))
check('WebSocket connection 为 Upgrade', wsHeaders.connection === 'Upgrade', String(wsHeaders.connection))
check('WebSocket 保留 sec-websocket-*', wsHeaders['sec-websocket-key'] === 'k')

const responseHeaders = rewrite.rewriteResponseHeaders({
  'content-type': 'text/html',
  'content-security-policy': "default-src 'self'",
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'set-cookie': ['dsh-auth-abc=v1.zzz; Path=/; HttpOnly; SameSite=Strict', 'extra=1; Domain=example.com; Secure'],
  connection: 'keep-alive',
})
check('剥离 CSP', responseHeaders['content-security-policy'] === undefined)
check('剥离 X-Frame-Options', responseHeaders['x-frame-options'] === undefined)
check('保留 content-type', responseHeaders['content-type'] === 'text/html')
check('剥离逐跳响应头', responseHeaders.connection === undefined)
const cookies = responseHeaders['set-cookie']
check('响应保留两条 cookie', Array.isArray(cookies) && cookies.length === 2, JSON.stringify(cookies))
check('cookie 去掉 Domain', cookies?.[1]?.includes('Domain') === false, String(cookies?.[1]))
check('cookie 去掉 Secure', cookies?.[1]?.includes('Secure') === false, String(cookies?.[1]))
check('cookie Path 归一为 /', cookies?.[0]?.includes('Path=/') === true, String(cookies?.[0]))

check('cookieHeaderFrom 拼装', rewrite.cookieHeaderFrom(['a=1; Path=/', 'b=2']) === 'a=1; b=2')
check('cookieHeaderFrom 空值', rewrite.cookieHeaderFrom(undefined) === undefined)
const ready = rewrite.parseReadyUrl('http://127.0.0.1:52478/?token=abc_DEF')
check('parseReadyUrl 取端口', ready?.port === 52478, String(ready?.port))
check('parseReadyUrl 取 token', ready?.token === 'abc_DEF', String(ready?.token))
check('parseReadyUrl 拒绝坏 URL', rewrite.parseReadyUrl('not-a-url') === undefined)
check('upstreamAuthority 固定回环', rewrite.upstreamAuthority(52478) === '127.0.0.1:52478')

/* ── 5. 实例控制接口 ── */

console.log('\n[5] 实例控制接口（真实 handler + 假 api）')
const { createControlHandler } = await import(pathToFileURL(resolve(root, 'lib/control/routes.js')).href)
const calls = []
const handler5 = createControlHandler({
  prefix: '/remote-desks',
  guard: () => undefined,
  api: {
    state: () => ({ ok: true }),
    instances: () => [{ id: 'a', phase: 'running' }],
    instance: (id) => (id === 'a' ? { id, phase: 'running' } : undefined),
    start: async (id) => {
      calls.push(['start', id])
      if (id === 'boom') throw new Error('实例 a 正在处理上一个操作')
      return { id, phase: 'starting' }
    },
    stop: async (id) => {
      calls.push(['stop', id])
      return { id, phase: 'stopped' }
    },
    restart: async (id) => ({ id, phase: 'starting' }),
    logs: (id, offset) => {
      calls.push(['logs', id, offset])
      return { nextOffset: 7, lines: [`line-${String(offset)}`] }
    },
  },
})
const call5 = (method, url) => {
  const res = fakeResponse()
  handler5({ method, url, headers: { host: '127.0.0.1:19387' } }, res)
  return res
}
const post5 = async (url) => {
  const res = fakeResponse()
  handler5({ method: 'POST', url, headers: { host: '127.0.0.1:19387' } }, res)
  await new Promise((done) => setTimeout(done, 20))
  return res
}

check('GET /api/instances → 200', call5('GET', '/remote-desks/api/instances').statusCode === 200)
check(
  '实例列表带 instances',
  JSON.parse(call5('GET', '/remote-desks/api/instances').body)?.instances?.[0]?.id === 'a',
)
check('GET 已知实例 → 200', call5('GET', '/remote-desks/api/instances/a').statusCode === 200)
check('GET 未知实例 → 404', call5('GET', '/remote-desks/api/instances/zzz').statusCode === 404)
check('logs 透传 offset', (() => {
  call5('GET', '/remote-desks/api/instances/a/logs?offset=5')
  return calls.some((entry) => entry[0] === 'logs' && entry[2] === 5)
})())
const startedRes = await post5('/remote-desks/api/instances/a/start')
check('POST start → 200', startedRes.statusCode === 200, String(startedRes.statusCode))
check('start 落到 api', calls.some((entry) => entry[0] === 'start' && entry[1] === 'a'))
const conflict = await post5('/remote-desks/api/instances/boom/start')
check('POST start 冲突 → 409', conflict.statusCode === 409, String(conflict.statusCode))
check('未知动作 → 404', call5('POST', '/remote-desks/api/instances/a/explode').statusCode === 404)
check('GET 方法打 start → 404', call5('GET', '/remote-desks/api/instances/a/start').statusCode === 404)

/* ── 6. SSH 层 ── */

console.log('\n[6] SSH 层（纯函数与适配器）')
const { createHash } = await import('node:crypto')
const { Duplex } = await import('node:stream')
const sshManager = await import(pathToFileURL(resolve(root, 'lib/ssh/manager.js')).href)
const spec = await import(pathToFileURL(resolve(root, 'lib/instances/spec.js')).href)
const upstream = await import(pathToFileURL(resolve(root, 'lib/mirror/upstream.js')).href)

const expected = `SHA256:${createHash('sha256').update('abc').digest('base64').replace(/=+$/, '')}`
check('主机密钥指纹格式', sshManager.fingerprintOf(Buffer.from('abc')) === expected, sshManager.fingerprintOf(Buffer.from('abc')))

// 非 net.Socket 的字节流要能被 http 客户端接受（缺 setTimeout 会把宿主进程搞崩）
const plain = new Duplex({ read() {}, write(_chunk, _enc, done) {
  done()
} })
check('裸 Duplex 缺 setTimeout', typeof plain.setTimeout !== 'function')
const shimmed = upstream.asSocket(plain)
check('asSocket 补上 setTimeout', typeof shimmed.setTimeout === 'function')
check('asSocket 补上 setNoDelay', typeof shimmed.setNoDelay === 'function')
check('asSocket 补上 address', typeof shimmed.address === 'function' && shimmed.address()?.port === 0)
check('asSocket 返回同一个对象', shimmed === plain)
const realSocket = new (await import('node:net')).Socket()
check('asSocket 对真 socket 不动手脚', upstream.asSocket(realSocket) === realSocket)

const command = spec.posixDshCommand('mirror-x', '/home/me/proj')
check('远端命令是单行', !command.includes('\n'))
check('远端命令不做变量赋值', !/(^|;\s*)[A-Za-z_][A-Za-z0-9_]*=/.test(command), command.slice(0, 80))
check('远端命令不含双引号', !command.includes('"'))
check('远端命令会初始化 profile', command.includes('package.json') && command.includes('base64 -d'))
check('远端命令处理 nvm', command.includes('nvm.sh'))
check('远端命令缺 dsh 时报错退出', command.includes('exit 127'))
check('远端命令用 exec 起 dsh', command.includes('exec dsh --profile mirror-x --port 0 --no-open'))
check('远端命令带上 cwd', command.includes(`cd '/home/me/proj'`))

const encodedPayload = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(command)?.[1]
let manifest
try {
  manifest = JSON.parse(Buffer.from(encodedPayload ?? '', 'base64').toString('utf8'))
} catch {
  manifest = undefined
}
check('base64 里的 profile 清单可解析', manifest !== undefined)
check('清单声明了两个 bundle', Array.isArray(manifest?.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.length === 2)

let sshMissingHost = false
try {
  spec.sshSpec({ id: 'x', kind: 'ssh', enabled: true, jumpHosts: [] })
} catch {
  sshMissingHost = true
}
check('sshSpec 缺 host 时报错', sshMissingHost)
const sshPlan = spec.planFor(
  { id: 'x', kind: 'ssh', enabled: true, host: 'h.example', username: 'u', jumpHosts: [] },
  undefined,
  'C:/dsh',
)
check('planFor 把 ssh 分到 ssh 传输', sshPlan.transport === 'ssh', sshPlan.transport)
check('ssh 计划不需要本机发行版', sshPlan.transport === 'ssh' && sshPlan.describe.includes('h.example'))

const connection = new sshManager.SshConnection({
  target: { host: 'h.example', port: 2222, username: 'deploy', auth: { method: 'agent' } },
  jumpHosts: [{ host: 'jump.example', port: 22, username: 'ops' }],
  resolveCredential: async () => undefined,
  log: () => {},
})
check('SSH 描述含跳板链', connection.describe().includes('jump.example') && connection.describe().includes('h.example'), connection.describe())

/* ── 7. 面板渲染（SSR：不跑 effect，但会把组件树真的执行一遍） ── */

console.log('\n[7] 面板渲染（react-dom/server）')
const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')
// 渲染路径必须用真的 jsx 运行时：先前那个桩返回 null，整棵树会渲染成空字符串。
const realJsxRuntime = await import('react/jsx-runtime')

/** 再加载一次 bundle，这次用**真的** react / react-dom 当 require 后端。 */
const realLoad = { factory: undefined }
const realSandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        realLoad.factory = definition.factory
      },
    },
  },
  console,
}
vm.runInNewContext(source, realSandbox, { filename: 'lib/client.js' })
const realRequire = (request) => {
  if (request === 'react') return React
  if (request === 'react/jsx-runtime') return realJsxRuntime
  throw new Error(`面板渲染只允许基线模块，收到：${request}`)
}
const realExports = realLoad.factory(realRequire)

const rendered = []
const renderCtx = {
  slots: {
    inject: (_key, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      rendered.push({ options, component })
      return () => {}
    },
  },
  layout: { selectPanel: () => {}, openRightbar: () => {} },
  sidebarRight: { openTab: () => {} },
}
realExports.apply(renderCtx)

const byName = (name) => rendered.find((entry) => entry.options.name === name)?.component
const panel = byName('main')
const icon = byName('sidebar.panellist')
const settings = byName('settings.section')
check('渲染前拿到三个组件', panel !== undefined && icon !== undefined && settings !== undefined)

// 带数据的实例列表与工具栏：这是用户点完启动会看到的那一屏。
const listComponent = realExports.InstanceList
const toolbarComponent = realExports.InstanceToolbar
check('导出了 InstanceList / InstanceToolbar', typeof listComponent === 'function' && typeof toolbarComponent === 'function')

const fixtureRunning = {
  id: 'local-dev',
  kind: 'local',
  label: '本机（内置运行时）',
  enabled: true,
  phase: 'running',
  detail: '运行中，远端端口 52478',
  remotePort: 52478,
  mirrorEntryUrl: 'http://127.0.0.1:19500/?k=ticket',
  version: '0.2.0-rc.1',
  logs: { nextOffset: 0, lines: [] },
}
const fixtureStopped = {
  id: 'wsl-ubuntu',
  kind: 'wsl',
  label: 'WSL · Ubuntu-24.04',
  enabled: true,
  phase: 'stopped',
  detail: '未启动',
  logs: { nextOffset: 0, lines: [] },
}

try {
  const listHtml = renderToStaticMarkup(
    React.createElement(listComponent, {
      instances: [fixtureRunning, fixtureStopped],
      activeId: 'local-dev',
      onSelect: () => {},
    }),
  )
  check('列表渲染出两个实例', listHtml.includes('本机（内置运行时）') && listHtml.includes('WSL · Ubuntu-24.04'))
  check('列表标出选中项', listHtml.includes('data-active="true"'))
  check('运行中的实例显示远端端口', listHtml.includes('远端 52478'), listHtml.slice(0, 200))
  check('停止的实例显示未启动', listHtml.includes('未启动'))
  check('列表带状态点', listHtml.includes('data-phase="running"') && listHtml.includes('data-phase="stopped"'))
  check('列表标出实例类型', listHtml.includes('本机') && listHtml.includes('WSL'))
} catch (error) {
  check('列表渲染出两个实例', false, error instanceof Error ? error.message : String(error))
}

try {
  const listEmpty = renderToStaticMarkup(
    React.createElement(listComponent, { instances: [], activeId: undefined, onSelect: () => {} }),
  )
  check('空列表给出配置指引', listEmpty.includes('cordis.patch.yml'))

  const runningToolbar = renderToStaticMarkup(
    React.createElement(toolbarComponent, {
      instance: fixtureRunning,
      busy: undefined,
      mirrorEntryUrl: fixtureRunning.mirrorEntryUrl,
      onAction: () => {},
      onCheck: () => {},
      onUpdate: () => {},
      onRollback: () => {},
    }),
  )
  check(
    '工具栏动作齐全',
    ['预检', '启动', '重启', '停止', '更新'].every((label) => runningToolbar.includes(label)),
    runningToolbar.slice(0, 120),
  )
  check('运行中时「启动」禁用、可「浏览器打开」', (runningToolbar.match(/disabled=""/g) ?? []).length >= 1)
  check('没有更新记录时不显示「回滚」', runningToolbar.includes('回滚') === false)
  check('工具栏显示版本', runningToolbar.includes('DSH 0.2.0-rc.1'), runningToolbar.slice(0, 200))

  const stoppedToolbar = renderToStaticMarkup(
    React.createElement(toolbarComponent, {
      instance: fixtureStopped,
      busy: undefined,
      mirrorEntryUrl: undefined,
      onAction: () => {},
      onCheck: () => {},
      onUpdate: () => {},
      onRollback: () => {},
    }),
  )
  check(
    '停止时按钮禁用数更多（停止/重启/浏览器打开）',
    (stoppedToolbar.match(/disabled=""/g) ?? []).length > (runningToolbar.match(/disabled=""/g) ?? []).length,
    `${String((stoppedToolbar.match(/disabled=""/g) ?? []).length)} vs ${String((runningToolbar.match(/disabled=""/g) ?? []).length)}`,
  )

  // 已停止 + 有更新记录 → 出现「回滚」，并显示上次结果
  const withUpdate = renderToStaticMarkup(
    React.createElement(toolbarComponent, {
      instance: {
        ...fixtureStopped,
        version: '0.2.0-rc.1',
        lastUpdate: {
          from: '0.2.0-rc.1',
          to: '0.3.0',
          command: 'npm i -g @deepseek-ai/dsh@latest',
          at: 1,
          ok: true,
          detail: '更新命令以 0 退出（版本 0.2.0-rc.1 → 0.3.0）',
          kind: 'update',
        },
      },
      busy: undefined,
      mirrorEntryUrl: undefined,
      onAction: () => {},
      onCheck: () => {},
      onUpdate: () => {},
      onRollback: () => {},
    }),
  )
  check('有更新记录后出现「回滚」', withUpdate.includes('回滚'))
  check('显示上次更新的版本变化', withUpdate.includes('0.2.0-rc.1') && withUpdate.includes('0.3.0'))
  check('回滚按钮在停止态可用', /回滚/.test(withUpdate))
  check('显示上周更新的成功状态', withUpdate.includes('成功'), withUpdate.slice(0, 200))
} catch (error) {
  check('空列表给出配置指引', false, error instanceof Error ? error.message : String(error))
}

try {
  const panelHtml = renderToStaticMarkup(React.createElement(panel, { layout: renderCtx.layout, rightbar: renderCtx.sidebarRight }))
  check('面板能渲染出 HTML', panelHtml.length > 100, `${String(panelHtml.length)} 字符`)
  check('面板标题是中文名', panelHtml.includes('远端工作台'))
  // 首屏还在拉实例列表：这时该说"正在读取"，而不是急着教用户去改配置。
  check('列表未就绪时给出读取提示', panelHtml.includes('正在读取实例列表'), panelHtml.slice(0, 160))
} catch (error) {
  check('面板能渲染出 HTML', false, error instanceof Error ? error.message : String(error))
}

/* 7b. 面板与切换器：带真实状态的渲染（数据从 props 来，因此 SSR 也能测） */

const PanelView = realExports.PanelView
const SwitcherView = realExports.WorkbenchSwitcherView
check('导出了 PanelView / WorkbenchSwitcherView', typeof PanelView === 'function' && typeof SwitcherView === 'function')

const hostReportFixture = {
  plugin: { name: 'dsh-remote-desks', displayName: '远端工作台', version: '0.1.0', milestone: 'M5' },
  host: { platform: 'win32', arch: 'x64', node: '24', electron: '44', execPath: 'x', dshHome: null, dshProfile: null, webPort: 19387, selfAttachable: true },
  services: { webServer: true },
  runtime: { found: true, version: '0.2.0-rc.2', entry: 'app.asar/dsh/lib/bin.js', inAsar: true, via: 'process.argv[1]', attempts: [] },
  control: { prefix: '/remote-desks', gate: 'loopback-guard' },
  config: {
    instances: 2,
    enabledInstances: 2,
    autoStart: 0,
    openMode: 'auto',
    attachInstances: 0,
    switcher: 'top-right',
    // 这一段测的是管理界面；统一界面在 7c 里单独测。
    layout: { mode: 'manage', collapseSidebar: false },
  },
}
const storeReady = {
  host: { phase: 'ready', value: hostReportFixture },
  instances: { phase: 'ready', value: [fixtureRunning, fixtureStopped] },
  selected: 'wsl-ubuntu',
}
/** 同一份数据、选中运行中的那条：切换器要能反映"当前这台在跑"。 */
const storeRunning = { ...storeReady, selected: 'local-dev' }
const panelActions = {
  refresh: () => {},
  select: () => {},
  lifecycle: async () => ({ ok: true }),
  version: async () => ({ ok: true }),
}

try {
  const html = renderToStaticMarkup(
    React.createElement(PanelView, { store: storeReady, actions: panelActions, layout: renderCtx.layout, rightbar: renderCtx.sidebarRight }),
  )
  check('带数据的面板渲染出列表', html.includes('本机（内置运行时）') && html.includes('WSL · Ubuntu-24.04'))
  check('面板按选中项显示（WSL 在前台的详情）', html.includes('WSL · Ubuntu-24.04') && html.includes('data-active="true"'))
  check('未运行实例给出启动提示', html.includes('实例未运行') || html.includes('点「启动」'))
  check('面板显示实例数量徽标', html.includes('2 个实例'))

  const emptyPanel = renderToStaticMarkup(
    React.createElement(PanelView, {
      store: { host: storeReady.host, instances: { phase: 'ready', value: [] } },
      actions: panelActions,
      layout: renderCtx.layout,
      rightbar: renderCtx.sidebarRight,
    }),
  )
  check('没有配置实例时给出可操作提示', emptyPanel.includes('cordis.patch.yml'), emptyPanel.slice(0, 160))

  const attachedPanel = renderToStaticMarkup(
    React.createElement(PanelView, {
      store: {
        host: storeReady.host,
        instances: {
          phase: 'ready',
          value: [
            {
              ...fixtureRunning,
              attached: true,
              detail: '运行中（吸附宿主自身，端口 19387）',
              remotePort: 19387,
            },
            fixtureStopped,
          ],
        },
        selected: 'local-dev',
      },
      actions: panelActions,
      layout: renderCtx.layout,
      rightbar: renderCtx.sidebarRight,
    }),
  )
  check('吸附的实例在列表里写明吸附', attachedPanel.includes('吸附本机'), attachedPanel.slice(0, 200))
  check('吸附的实例在详情的状态栏写明', attachedPanel.includes('吸附宿主自身'))
} catch (error) {
  check('带数据的面板渲染出列表', false, error instanceof Error ? error.message : String(error))
}

try {
  const html = renderToStaticMarkup(
    React.createElement(SwitcherView, {
      store: storeRunning,
      actions: { select: () => {} },
      services: { layout: renderCtx.layout },
    }),
  )
  check('切换器是一个下拉框', html.includes('<select'))
  // 用户说"字太多"——下拉项只留关键字，"运行中"这类状态另有位置，长说明进 title。
  check('下拉项只留关键字（去掉括注）', html.includes('>本机</option>'), html.slice(0, 400))
  check('下拉项保留用户自己的关键字', html.includes('WSL · Ubuntu-24.04'))
  check('下拉项不再带「（运行中）」这种尾巴', html.includes('（运行中）') === false)
  check('长说明进了悬停提示', html.includes('运行中，远端端口'), html.slice(0, 400))
  check('切换器标出当前选中项', html.includes('selected=""'), html.slice(0, 240))
  check('切换器标出运行状态', html.includes('data-phase="running"'))
  check('状态只写两三个字', html.includes('>运行中</span>'), html.slice(0, 400))
  check('切换器默认贴上边中间（不挡右上角的图标）', html.includes('data-corner="top-center"'), html.slice(0, 200))
  check('切换器把位置做成 CSS 变量（贴角时用得上）', html.includes('--drd-switch-x'))
  // 顶部留空 = 跟随官方 --dsh-frame-overlay-top（桌面版 = 标题栏高度 + 20px），别写死像素。
  check('默认不写死顶部像素，跟官方浮层基线', html.includes('--drd-switch-y') === false, html.slice(0, 240))
} catch (error) {
  check('切换器是一个下拉框', false, error instanceof Error ? error.message : String(error))
}

try {
  const html = renderToStaticMarkup(
    React.createElement(SwitcherView, {
      store: storeReady,
      actions: { select: () => {} },
      services: { layout: renderCtx.layout },
      preference: { enabled: false, corner: 'top-right', offsetX: 0, offsetY: 0 },
    }),
  )
  check('switcher.enabled=false 时不渲染', html === '', html.slice(0, 80))

  const leftHtml = renderToStaticMarkup(
    React.createElement(SwitcherView, {
      store: storeReady,
      actions: { select: () => {} },
      services: { layout: renderCtx.layout },
      preference: { enabled: true, corner: 'top-left', offsetX: 12, offsetY: 12 },
    }),
  )
  check('可以改贴左上角', leftHtml.includes('data-corner="top-left"') && leftHtml.includes('--drd-switch-x:12px'), leftHtml.slice(0, 200))

  const emptyHtml = renderToStaticMarkup(
    React.createElement(SwitcherView, {
      store: { host: { phase: 'ready', value: hostReportFixture }, instances: { phase: 'ready', value: [] } },
      actions: { select: () => {} },
      services: { layout: renderCtx.layout },
    }),
  )
  check('没有实例时不渲染空下拉框', emptyHtml === '')
} catch (error) {
  check('switcher.enabled=false 时不渲染', false, error instanceof Error ? error.message : String(error))
}

try {
  const iconHtml = renderToStaticMarkup(React.createElement(icon, { size: 20, active: false }))
  check('侧栏图标渲染为 svg', iconHtml.startsWith('<svg') && iconHtml.includes('width="20"'), iconHtml.slice(0, 40))
} catch (error) {
  check('侧栏图标渲染为 svg', false, error instanceof Error ? error.message : String(error))
}

try {
  const settingsHtml = renderToStaticMarkup(React.createElement(settings, {}))
  check('设置页能渲染出 HTML', settingsHtml.includes('设置') && settingsHtml.includes('配置示例'), `${String(settingsHtml.length)} 字符`)
} catch (error) {
  check('设置页能渲染出 HTML', false, error instanceof Error ? error.message : String(error))
}

/* ── 8. 更新 / 回滚 ── */

console.log('\n[8] 更新与回滚（纯逻辑 + 接口）')
const updateMod = await import(pathToFileURL(resolve(root, 'lib/instances/update.js')).href)

check('parseVersion 解析裸版本', updateMod.parseVersion('0.2.0-rc.1') === '0.2.0-rc.1')
check('parseVersion 从输出里挑版本', updateMod.parseVersion('dsh 1.2.3\n') === '1.2.3', String(updateMod.parseVersion('dsh 1.2.3')))
check('parseVersion 无版本返回 undefined', updateMod.parseVersion('command not found') === undefined)

check('isImmutableRuntime 认出 app.asar', updateMod.isImmutableRuntime('C:/x/app.asar/dsh/lib/bin.js') === true)
check('isImmutableRuntime 对普通路径为假', updateMod.isImmutableRuntime('D:/dsh/lib/bin.js') === false)
check('isImmutableRuntime 对 undefined 为假', updateMod.isImmutableRuntime(undefined) === false)

check('renderCommand 替换 {version}', updateMod.renderCommand('npm i -g x@{version}', '1.2.3') === 'npm i -g x@1.2.3')
check('renderCommand 无占位符则原样', updateMod.renderCommand('npm i -g x@latest', '1.2.3') === 'npm i -g x@latest')

const wslInstance = { id: 'w', kind: 'wsl', enabled: true, distro: 'Ubuntu', jumpHosts: [] }
const localInstance = { id: 'l', kind: 'local', enabled: true, jumpHosts: [] }
const planWsl = updateMod.resolveUpdatePlan(wslInstance, 'D:/dsh/lib/bin.js', 'latest')
check('wsl 有默认更新命令', planWsl.ok && planWsl.command === 'npm i -g @deepseek-ai/dsh@latest', String(planWsl.command))
check('wsl 默认命令可回滚（带 {version}）', planWsl.versioned === true)
const planLocal = updateMod.resolveUpdatePlan(localInstance, 'D:/dsh/lib/bin.js', 'latest')
check('本机实例没有默认更新方式', planLocal.ok === false, String(planLocal.reason ?? '').slice(0, 60))
check('并说明要写 updateCommand', String(planLocal.reason ?? '').includes('updateCommand'))
const planAsar = updateMod.resolveUpdatePlan(localInstance, 'C:/app/app.asar/dsh/lib/bin.js', 'latest')
check('内置运行时拒绝更新', planAsar.ok === false && String(planAsar.reason).includes('app.asar'))
const configured = { ...localInstance, updateCommand: 'echo probe {version}' }
const planConfigured = updateMod.resolveUpdatePlan(configured, 'D:/dsh/lib/bin.js', '9.9.9')
check('显式配置生效', planConfigured.ok && planConfigured.command === 'echo probe 9.9.9', String(planConfigured.command))

// 接口层：用假 api 走一遍真实 handler
const lifecycleCalls = []
const handler8 = createControlHandler({
  prefix: '/remote-desks',
  guard: () => undefined,
  api: {
    state: () => ({}),
    instances: () => [],
    instance: () => undefined,
    start: async () => ({}),
    stop: async () => ({}),
    restart: async () => ({}),
    logs: () => ({ nextOffset: 0, lines: [] }),
    check: async () => ({ checks: [] }),
    version: async (id) => {
      lifecycleCalls.push(['version', id])
      return { id, ok: true, version: '0.2.0-rc.1' }
    },
    update: async (id, target) => {
      lifecycleCalls.push(['update', id, target])
      if (id === 'running') throw new Error('实例 running 当前是「running」，请先停止再更新')
      if (id === 'immutable') throw new Error('这个实例用的是桌面版自带运行时（app.asar 内的 DSH）')
      return { id, ok: true, kind: 'update' }
    },
    rollback: async (id) => {
      lifecycleCalls.push(['rollback', id])
      return { id, ok: true, kind: 'rollback' }
    },
  },
})
const call8 = async (method, url, body) => {
  const res = fakeResponse()
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:19387' },
    setEncoding() {},
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(body)
      if (event === 'end') handler()
      return this
    },
  }
  handler8(req, res)
  await new Promise((done) => setTimeout(done, 30))
  return res
}

check('GET version → 200', (await call8('GET', '/remote-desks/api/instances/a/version')).statusCode === 200)
check('version 落到 api', lifecycleCalls.some((entry) => entry[0] === 'version'))
const updated = await call8('POST', '/remote-desks/api/instances/a/update', '{"target":"0.1.0"}')
check('POST update → 200', updated.statusCode === 200, String(updated.statusCode))
check('update 透传 target', lifecycleCalls.some((entry) => entry[0] === 'update' && entry[2] === '0.1.0'))
check('无 body 的 update 也接受', (await call8('POST', '/remote-desks/api/instances/a/update')).statusCode === 200)
const runningRejected = await call8('POST', '/remote-desks/api/instances/running/update')
check('运行中更新 → 409', runningRejected.statusCode === 409, String(runningRejected.statusCode))
check(
  '409 里带着原因',
  String(JSON.parse(runningRejected.body).message).includes('先停止'),
  String(JSON.parse(runningRejected.body).message ?? '').slice(0, 60),
)
check('内置运行时更新 → 409', (await call8('POST', '/remote-desks/api/instances/immutable/update')).statusCode === 409)
check('POST rollback → 200', (await call8('POST', '/remote-desks/api/instances/a/rollback')).statusCode === 200)
check('GET 打 update → 404', (await call8('GET', '/remote-desks/api/instances/a/update')).statusCode === 404)

/* 7c. 统一界面（immersive）：远端那套 DSH 的界面铺满主区，我们只剩一条很轻的浮条 */

const shortLabel = realExports.shortLabel
const shortStatus = realExports.shortStatus
const layoutModeOf = realExports.layoutModeOf
check(
  '导出了短标签 / 状态 / 形态判定',
  typeof shortLabel === 'function' && typeof shortStatus === 'function' && typeof layoutModeOf === 'function',
)
check('短标签去掉括注', shortLabel(fixtureRunning) === '本机', shortLabel(fixtureRunning))
check('短标签不重复类型词', shortLabel(fixtureStopped) === 'WSL · Ubuntu-24.04', shortLabel(fixtureStopped))
check(
  '短标签补类型词',
  shortLabel({ id: 'vm-1', kind: 'ssh', label: '虚拟机 Ubuntu', phase: 'stopped' }) === 'SSH · 虚拟机 Ubuntu',
  shortLabel({ id: 'vm-1', kind: 'ssh', label: '虚拟机 Ubuntu', phase: 'stopped' }),
)
check('没有 label 时退回 id', shortLabel({ id: 'vm-1', kind: 'ssh', phase: 'stopped' }) === 'SSH · vm-1', shortLabel({ id: 'vm-1', kind: 'ssh', phase: 'stopped' }))
check('状态词：运行中', shortStatus(fixtureRunning) === '运行中', shortStatus(fixtureRunning))
check('状态词：吸附时叫已连接', shortStatus({ ...fixtureRunning, attached: true }) === '已连接')
check('状态词：未启动', shortStatus(fixtureStopped) === '未启动', shortStatus(fixtureStopped))
check('状态词：出错', shortStatus({ ...fixtureRunning, phase: 'error' }) === '出错')
check('形态默认跟随配置', layoutModeOf(storeReady) === 'manage', String(layoutModeOf(storeReady)))
check(
  '用户点过就以用户为准',
  layoutModeOf({ ...storeReady, layoutOverride: 'immersive' }) === 'immersive',
)
check(
  '配置默认是统一界面',
  layoutModeOf({ ...storeReady, host: { phase: 'ready', value: { ...hostReportFixture, config: { ...hostReportFixture.config, layout: { mode: 'immersive' } } } } }) === 'immersive',
)

const storeImmersive = {
  ...storeReady,
  layoutOverride: 'immersive',
}
const immersiveHost = {
  phase: 'ready',
  value: { ...hostReportFixture, config: { ...hostReportFixture.config, layout: { mode: 'immersive', collapseSidebar: false } } },
}

try {
  const html = renderToStaticMarkup(
    React.createElement(PanelView, { store: { ...storeImmersive, selected: 'local-dev' }, actions: panelActions, layout: renderCtx.layout, rightbar: renderCtx.sidebarRight }),
  )
  check('统一界面铺满（drd-immersive）', html.includes('drd-immersive'))
  check('统一界面下没有实例列表与工具栏', html.includes('drd-list') === false && html.includes('drd-toolbar') === false)
  // SSR 不跑 effect，所以镜像载体（iframe/webview）在这层看不到；这里断言"镜像区在、且铺满由 CSS 负责"，
  // 真的铺满由 verify:ui 在浏览器里量矩形。
  check('统一界面下有镜像区', html.includes('drd-stage'), html.slice(0, 240))
  check('浮条有关键字与状态', html.includes('>本机<') && html.includes('运行中'))
  check('浮条有「管理」出口', html.includes('>管理</button>'))
  check('浮条有「全窗口」与「重载」', html.includes('>全窗口</button>') && html.includes('>重载</button>'))

  // 未运行 → 不是把人丢进管理界面，而是给一个能直接启动的卡片。
  const stoppedHtml = renderToStaticMarkup(
    React.createElement(PanelView, { store: { ...storeImmersive, selected: 'wsl-ubuntu' }, actions: panelActions, layout: renderCtx.layout, rightbar: renderCtx.sidebarRight }),
  )
  check('未运行时给启动卡片', stoppedHtml.includes('>启动</button>') && stoppedHtml.includes('WSL · Ubuntu-24.04'))
  check('未运行时也留着「管理界面」出口', stoppedHtml.includes('管理界面'))

  // 配置里的默认形态：没被用户覆盖时按配置走。
  const configuredHtml = renderToStaticMarkup(
    React.createElement(PanelView, {
      store: { host: immersiveHost, instances: { phase: 'ready', value: [fixtureRunning, fixtureStopped] }, selected: 'local-dev' },
      actions: panelActions,
      layout: renderCtx.layout,
      rightbar: renderCtx.sidebarRight,
    }),
  )
  check('配置成统一界面时首屏就是统一界面', configuredHtml.includes('drd-immersive'))

  const managedHtml = renderToStaticMarkup(
    React.createElement(PanelView, {
      store: { ...storeImmersive, layoutOverride: 'manage' },
      actions: panelActions,
      layout: renderCtx.layout,
      rightbar: renderCtx.sidebarRight,
    }),
  )
  check('切回管理界面后列表与工具栏都在', managedHtml.includes('drd-list') && managedHtml.includes('drd-toolbar'))
  check('管理界面里有「统一界面」出口', managedHtml.includes('>统一界面</button>'))

  // 保活（切到另一台时前一台不卸载）需要组件内 state，SSR 跑不到 effect——
  // 这条留给 verify:ui 在浏览器里用**两个实例**真真切切地切一次（见 scripts/ui-verify/main.cjs）。
  check('统一界面同一时刻只渲染当前这台（首次渲染）', (html.match(/drd-keep/g) ?? []).length === 1, String((html.match(/drd-keep/g) ?? []).length))
} catch (error) {
  check('统一界面铺满（drd-immersive）', false, error instanceof Error ? error.message : String(error))
}

/* ── 9. 吸附宿主自身（本机内置运行 = 已经在跑） ── */

console.log('\n[9] 吸附宿主自身（attach：不拉进程，直接接上在跑的那套 DSH）')
const attachMod = await import(pathToFileURL(resolve(root, 'lib/instances/attach.js')).href)
const { InstanceSupervisor } = await import(pathToFileURL(resolve(root, 'lib/instances/supervisor.js')).href)
const { createServer } = await import('node:http')

// host 半的快照里要真的带 attached 标记（客户端据此显示"吸附本机"）。
const supervisorSource = readFileSync(resolve(root, 'lib/instances/supervisor.js'), 'utf8')
check('快照带 attached 标记', supervisorSource.includes('attached === true') && supervisorSource.includes('attached: true'))
check('吸附实现里没有 terminate', /attachSelf[\s\S]{0,4000}?terminate/.test(supervisorSource) === false)

const attachLocal = { id: 'local-dev', kind: 'local', enabled: true, jumpHosts: [] }
const attachWsl = { id: 'wsl', kind: 'wsl', enabled: true, distro: 'Ubuntu', jumpHosts: [] }
const desktopRuntime = { entry: 'C:/app/app.asar/dsh/lib/bin.js', execPath: 'C:/app/x.exe', electron: true, inAsar: true }
const cliRuntime = { entry: 'C:/npm/dsh/lib/bin.js', execPath: 'C:/node/node.exe', electron: false, inAsar: false }
const selfFixture = { port: 19387, authenticatedUrl: 'http://127.0.0.1:19387/?token=t', tokenized: true, describe: '宿主自身' }

check('桌面内置运行时 + 本机实例 → 吸附', attachMod.decideAttach(attachLocal, selfFixture, desktopRuntime).attach === true)
check(
  'attach: false → 不吸附',
  attachMod.decideAttach({ ...attachLocal, attach: false }, selfFixture, desktopRuntime).attach === false,
)
check(
  '非桌面宿主 → 不吸附（老行为不变）',
  attachMod.decideAttach(attachLocal, selfFixture, cliRuntime).attach === false,
)
check(
  '显式 attach: true → 任何宿主都吸附',
  attachMod.decideAttach({ ...attachLocal, attach: true }, selfFixture, cliRuntime).attach === true,
)
check(
  '指定了别的入口 → 不吸附',
  attachMod.decideAttach({ ...attachLocal, entry: 'D:/other/lib/bin.js' }, selfFixture, desktopRuntime).attach === false,
)
check(
  '拿不到宿主端点 → 不吸附，并说明原因',
  (() => {
    const decision = attachMod.decideAttach(attachLocal, undefined, desktopRuntime)
    return decision.attach === false && decision.reason.includes('无法吸附')
  })(),
)
check('wsl 实例不参与吸附', attachMod.decideAttach(attachWsl, selfFixture, desktopRuntime).attach === false)

// 一个真的会「303 + set-cookie」的假宿主：模拟桌面壳启动时那条换取会话的路。
// 顺带模拟启动早期的两件事：前两次带令牌的请求返回 404（前端兜底路由还没认领 `/`），
// 以及最开始几次探测拿不到进程令牌（connection 服务还没挂上）。
const hostHits = []
let spawnCalls = 0
let earlyMisses = 2
let bundleHits = 0
const fakeHost = createServer((req, res) => {
  hostHits.push(req.url ?? '')
  if ((req.url ?? '').startsWith('/?token=')) {
    if (earlyMisses > 0) {
      earlyMisses -= 1
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(303, { 'set-cookie': ['dsh-auth-host=v1.test; Path=/; HttpOnly'], location: '/' })
    res.end()
    return
  }
  // 前端 bundle：带内容哈希（`rev=`），镜像端点的缓存只认这种。
  if ((req.url ?? '').startsWith('/plugins/')) {
    bundleHits += 1
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    })
    res.end('window.__ModuleLoader__ = { load() {} };')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    '<!doctype html><html><body><div id="root">host-ui</div>' +
      '<script src="plugins/??a,b&rev=deadbeef"></script></body></html>',
  )
})
await new Promise((done) => fakeHost.listen(0, '127.0.0.1', done))
const hostPort = fakeHost.address().port

let selfProbes = 0
const selfWithDelay = () => {
  selfProbes += 1
  // 前三次：端口有了，但拿不到进程令牌（裸地址换不到 cookie）。
  const tokenized = selfProbes > 3
  return {
    port: hostPort,
    authenticatedUrl: tokenized
      ? `http://127.0.0.1:${String(hostPort)}/?token=smoke`
      : `http://127.0.0.1:${String(hostPort)}/`,
    tokenized,
    describe: '宿主自身',
  }
}

const supervisor = new InstanceSupervisor(
  { instances: [attachLocal], mirror: { host: '127.0.0.1', portRange: [0, 0] } },
  {
    dshHome: resolve(root, '.recon', 'smoke-dsh-home'),
    localRuntime: () => desktopRuntime,
    hostSelf: selfWithDelay,
    resolveCredential: async () => undefined,
    log: () => {},
  },
  // 宿主"没有" subprocess 服务：真去拉进程就会失败，因此吸附成功本身证明它没拉进程。
  () => {
    spawnCalls += 1
    return undefined
  },
)

const attachedSnapshot = await supervisor.start('local-dev')
check('吸附后 phase=running', attachedSnapshot.phase === 'running', String(attachedSnapshot.phase))
check('吸附后带 attached 标记', attachedSnapshot.attached === true)
check('吸附不调用 subprocess', spawnCalls === 0, `实际 ${String(spawnCalls)}`)
check('吸附的远端端口就是宿主端口', attachedSnapshot.remotePort === hostPort, String(attachedSnapshot.remotePort))
check('吸附后给出镜像入口', typeof attachedSnapshot.mirrorEntryUrl === 'string', String(attachedSnapshot.mirrorEntryUrl))
check('吸附走的是宿主令牌地址', hostHits.some((url) => url.includes('token=smoke')), JSON.stringify(hostHits))
check('等到了进程令牌（不是拿裸地址硬试）', selfProbes > 3, `探测 ${String(selfProbes)} 次`)
check(
  '启动早期的 404 被退避重试吃掉了',
  hostHits.filter((url) => url.includes('token=')).length >= 3,
  JSON.stringify(hostHits.slice(0, 6)),
)
check('吸附说明写在 detail 里', String(attachedSnapshot.detail).includes('吸附宿主自身'), String(attachedSnapshot.detail))

// 预热：实例一就绪就把首页里引用的前端资源先拉进镜像缓存（远端那套是按需拼 combo bundle 的，
// 不预热的话这份成本就落在用户切过去那一刻）。
const warmDeadline = Date.now() + 15_000
while (Date.now() < warmDeadline && !supervisor.logs('local-dev', 0).lines.some((line) => line.includes('预热：'))) {
  await new Promise((done) => setTimeout(done, 200))
}
const warmLogs = supervisor.logs('local-dev', 0).lines
check(
  '就绪后自己预热前端资源',
  warmLogs.some((line) => line.includes('预热：') && line.includes('/1 个前端资源')),
  warmLogs.filter((line) => line.includes('预热')).join(' | ').slice(0, 160),
)
check('预热真的去取了那个 bundle', bundleHits >= 1, `上游收到 ${String(bundleHits)} 次`)

// 缓存：再取一次同一个 bundle，应当由镜像端点自己回（上游次数不再增加）。
const bundleResponse = await fetch(`${attachedSnapshot.mirrorBaseUrl}plugins/??a,b&rev=deadbeef`, {
  headers: { cookie: `dsh_mirror=${decodeURIComponent(new URL(attachedSnapshot.mirrorEntryUrl).searchParams.get('k') ?? '')}` },
})
const cachedBody = await bundleResponse.text()
check('带票据能取到 bundle', bundleResponse.status === 200, String(bundleResponse.status))
const hitsAfterWarm = bundleHits
const second = await fetch(`${attachedSnapshot.mirrorBaseUrl}plugins/??a,b&rev=deadbeef`, {
  headers: { cookie: `dsh_mirror=${decodeURIComponent(new URL(attachedSnapshot.mirrorEntryUrl).searchParams.get('k') ?? '')}` },
})
check('同一份 bundle 走镜像缓存（上游不再被敲）', bundleHits === hitsAfterWarm, `上游次数 ${String(bundleHits)}`)
check('缓存回包带 x-drd-cache: hit', second.headers.get('x-drd-cache') === 'hit', String(second.headers.get('x-drd-cache')))
check('缓存内容与第一次一致', (await second.text()) === cachedBody)
// 没带哈希的路径不缓存（避免把 `/api/*` 那种动态内容也存下来）。
const upstreamHitsBeforeDynamic = hostHits.length
await fetch(`${attachedSnapshot.mirrorBaseUrl}`, {
  headers: { cookie: `dsh_mirror=${decodeURIComponent(new URL(attachedSnapshot.mirrorEntryUrl).searchParams.get('k') ?? '')}` },
})
check('不带哈希的页面不进缓存', hostHits.length > upstreamHitsBeforeDynamic, `上游 ${String(hostHits.length - upstreamHitsBeforeDynamic)} 次`)

// 镜像端点要真的能把宿主那套 UI 搬过来：带票据 → 换 cookie → 取回内容。
const entry = attachedSnapshot.mirrorEntryUrl
const first = await fetch(entry, { redirect: 'manual' })
const ticketCookie = (first.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? ''
check('带票据访问镜像 → 302', first.status === 302, String(first.status))
check('换取镜像票据 cookie', ticketCookie.startsWith('dsh_mirror='), ticketCookie)
const mirrored = await fetch(entry.split('?')[0], { headers: { cookie: ticketCookie } })
const mirroredBody = await mirrored.text()
check('带票据 cookie 取回宿主 UI → 200', mirrored.status === 200, String(mirrored.status))
check('镜像回来的就是宿主那一屏', mirroredBody.includes('host-ui'), mirroredBody.slice(0, 80))
const naked = await fetch(entry.split('?')[0])
check('无票据仍被拒', naked.status === 403, String(naked.status))

// 预检：吸附的实例不再问 profile / cwd，只回答吸附本身。
const checked = await supervisor.check('local-dev')
check('预检回答吸附而不是 profile', checked.checks[0]?.name === '吸附宿主自身', JSON.stringify(checked.checks[0]))
check('预检第一项通过', checked.checks[0]?.ok === true)

// 停止只收镜像，不动宿主。
const stoppedSnapshot = await supervisor.stop('local-dev')
check('停止吸附实例 → stopped', stoppedSnapshot.phase === 'stopped', String(stoppedSnapshot.phase))
check('停止吸附实例不动宿主', fakeHost.listening === true)
check('停止后不再暴露镜像地址', stoppedSnapshot.mirrorEntryUrl === undefined)
check('停止说明仍指出宿主在跑', String(stoppedSnapshot.detail).includes('宿主自身的 DSH 仍在运行'), String(stoppedSnapshot.detail))

// 再吸附一次：镜像 origin 必须复用（浏览器缓存 + 镜像里那套 DSH 自己的 localStorage 都挂在 origin 上，
// 换端口 = 冷缓存 + 丢掉远端界面的偏好，用户看到的就是"每次切过去都要重新渲染"）。
const reattachedSmoke = await supervisor.start('local-dev')
check(
  '再吸附复用同一个镜像端口',
  reattachedSmoke.mirrorBaseUrl === attachedSnapshot.mirrorBaseUrl,
  `${String(attachedSnapshot.mirrorBaseUrl)} → ${String(reattachedSmoke.mirrorBaseUrl)}`,
)
check(
  '复用端口时入口票据是新的',
  reattachedSmoke.mirrorEntryUrl !== attachedSnapshot.mirrorEntryUrl,
  String(reattachedSmoke.mirrorEntryUrl),
)
await supervisor.dispose()

// autoAttach：桌面应用打开时该自己接上，不需要用户点。
const autoSupervisor = new InstanceSupervisor(
  {
    instances: [attachLocal, { ...attachLocal, id: 'local-off', attach: false }, attachWsl],
    mirror: { host: '127.0.0.1', portRange: [0, 0] },
  },
  {
    dshHome: resolve(root, '.recon', 'smoke-dsh-home'),
    localRuntime: () => desktopRuntime,
    hostSelf: () => ({
      port: hostPort,
      authenticatedUrl: `http://127.0.0.1:${String(hostPort)}/?token=smoke`,
      tokenized: true,
      describe: '宿主自身',
    }),
    resolveCredential: async () => undefined,
    log: () => {},
  },
  () => undefined,
)
const autoAttached = await autoSupervisor.autoAttach()
check('autoAttach 只接上该吸附的那条', JSON.stringify(autoAttached) === '["local-dev"]', JSON.stringify(autoAttached))
const autoSnapshot = autoSupervisor.snapshot('local-dev')
check('autoAttach 后就是运行中（打开应用即运行中）', autoSnapshot?.phase === 'running')
await autoSupervisor.dispose()
await new Promise((done) => fakeHost.close(done))

/* ── 10. 票据 cookie 的跨站形态（桌面版 iframe 的命门） ── */

console.log('\n[10] 票据 cookie：跨站 iframe 也要能用')
const endpointMod = await import(pathToFileURL(resolve(root, 'lib/mirror/endpoint.js')).href)
const upstreamMod = await import(pathToFileURL(resolve(root, 'lib/mirror/upstream.js')).href)

check('跨站判定：cross-site 为真', endpointMod.isCrossSite({ headers: { 'sec-fetch-site': 'cross-site' } }) === true)
check('跨站判定：same-origin 为假', endpointMod.isCrossSite({ headers: { 'sec-fetch-site': 'same-origin' } }) === false)
check('跨站判定：same-site 为假', endpointMod.isCrossSite({ headers: { 'sec-fetch-site': 'same-site' } }) === false)
// 桌面版顶层是 dsh-app://app，浏览器一般会写 cross-site；拿不到这个头时按最保守的跨站处理。
check('跨站判定：缺头按跨站处理', endpointMod.isCrossSite({ headers: {} }) === true)
const crossCookie = endpointMod.ticketCookie('TICKET', true)
check(
  '跨站 cookie 是 SameSite=None; Secure',
  crossCookie.includes('SameSite=None') && crossCookie.includes('Secure'),
  crossCookie,
)
check('跨站 cookie 仍旧 HttpOnly 且 Path=/', crossCookie.includes('HttpOnly') && crossCookie.includes('Path=/'), crossCookie)
// 缓存判据：只认内容寻址的静态资源，且**只认未压缩的**——预热的 fetch 会自动解压，
// 若把它存进同一个 key，浏览器按 gzip 去解就会炸（活体验证里翻过一次车）。
check(
  'cacheableResponse 认得带 rev 的 combo bundle',
  endpointMod.cacheableResponse('GET', '/plugins/??a,b&rev=deadbeef', 200, { 'content-type': 'text/javascript; charset=utf-8' }) !== undefined,
)
check(
  'cacheableResponse 认得带哈希的 assets',
  endpointMod.cacheableResponse('GET', '/assets/index-abcdef12.js', 200, { 'content-type': 'text/javascript' }) !== undefined,
)
check(
  'cacheableResponse 拒绝带 content-encoding 的响应',
  endpointMod.cacheableResponse('GET', '/plugins/??a,b&rev=deadbeef', 200, {
    'content-type': 'text/javascript',
    'content-encoding': 'gzip',
  }) === undefined,
)
check(
  'cacheableResponse 拒绝 /api/ 与无哈希路径',
  endpointMod.cacheableResponse('GET', '/api/state?rev=x', 200, { 'content-type': 'application/json' }) === undefined &&
    endpointMod.cacheableResponse('GET', '/plugins/??a,b', 200, { 'content-type': 'text/javascript' }) === undefined,
)
check(
  'cacheableResponse 只认 GET 200',
  endpointMod.cacheableResponse('POST', '/plugins/??a&rev=x', 200, { 'content-type': 'text/javascript' }) === undefined &&
    endpointMod.cacheableResponse('GET', '/plugins/??a&rev=x', 404, { 'content-type': 'text/javascript' }) === undefined,
)
const sameCookie = endpointMod.ticketCookie('TICKET', false)
check(
  '同站 cookie 仍旧是 Lax（少给一点权限）',
  sameCookie.includes('SameSite=Lax') && sameCookie.includes('Secure') === false,
  sameCookie,
)

// 端到端：跨站访客带票据 → 302 + 跨站 cookie → 带 cookie 取回上游内容；不带就 403。
const ticketUpstream = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body>upstream-ok</body></html>')
})
await new Promise((done) => ticketUpstream.listen(0, '127.0.0.1', done))
const ticketUpstreamPort = ticketUpstream.address().port
const endpoint = new endpointMod.MirrorEndpoint({
  instanceId: 'cross-site-probe',
  remotePort: ticketUpstreamPort,
  connector: upstreamMod.tcpUpstream('127.0.0.1', ticketUpstreamPort, 'local'),
  cookie: () => undefined,
  bindHost: '127.0.0.1',
  port: 0,
})
const endpointInfo = await endpoint.start()
try {
  const exchanged = await fetch(endpointInfo.entryUrl, {
    redirect: 'manual',
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  const setCookie = (exchanged.headers.getSetCookie?.() ?? [])[0] ?? ''
  check('跨站访客带票据 → 302', exchanged.status === 302, String(exchanged.status))
  check('换到的 cookie 是跨站形态', /SameSite=None/i.test(setCookie) && /Secure/i.test(setCookie), setCookie)
  const pair = setCookie.split(';')[0]
  const mirrored = await fetch(endpointInfo.baseUrl, { headers: { cookie: pair } })
  check('带上它就能取回上游内容', mirrored.status === 200 && (await mirrored.text()).includes('upstream-ok'), String(mirrored.status))
  const bare = await fetch(endpointInfo.baseUrl)
  check('不带票据仍旧 403（闸门还在）', bare.status === 403, String(bare.status))
  const sameSiteExchange = await fetch(endpointInfo.entryUrl, {
    redirect: 'manual',
    headers: { 'sec-fetch-site': 'same-origin' },
  })
  const sameSiteCookie = (sameSiteExchange.headers.getSetCookie?.() ?? [])[0] ?? ''
  check('同站访客拿到的是 Lax', sameSiteCookie.includes('SameSite=Lax'), sameSiteCookie)
} finally {
  await endpoint.close()
  await new Promise((done) => ticketUpstream.close(done))
}

// 显式要求吸附却吸附不了：明说，不悄悄退回"自己拉一份"。
const noSelfSupervisor = new InstanceSupervisor(
  { instances: [{ ...attachLocal, attach: true }], mirror: { host: '127.0.0.1', portRange: [0, 0] } },
  {
    dshHome: resolve(root, '.recon', 'smoke-dsh-home'),
    localRuntime: () => desktopRuntime,
    hostSelf: () => undefined,
    resolveCredential: async () => undefined,
    log: () => {},
  },
  () => undefined,
)
let refusal = ''
try {
  await noSelfSupervisor.start('local-dev')
} catch (error) {
  refusal = error instanceof Error ? error.message : String(error)
}
check('吸附不了时明确拒绝', refusal.includes('要求吸附'), refusal)
check('拒绝时不假装运行中', noSelfSupervisor.snapshot('local-dev')?.phase !== 'running')
await noSelfSupervisor.dispose()

/* ── 汇总 ── */

console.log('')
if (failures.length > 0) {
  console.error(`冒烟测试失败：${failures.length}/${checks}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`冒烟测试通过：${checks} 项`)

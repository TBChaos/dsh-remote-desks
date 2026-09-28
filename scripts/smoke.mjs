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
const withInstance = host.Config({
  instances: [{ id: 'demo', kind: 'local' }],
})
check('实例默认 enabled', withInstance.instances[0]?.enabled === true)
check('实例默认 jumpHosts', Array.isArray(withInstance.instances[0]?.jumpHosts))
check('实例默认 auth.method=agent', withInstance.instances[0]?.auth?.method === 'agent', String(withInstance.instances[0]?.auth?.method))
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
check('注册总数=3', registered.length === 3, `实际 ${registered.length}`)

/* ── 汇总 ── */

console.log('')
if (failures.length > 0) {
  console.error(`冒烟测试失败：${failures.length}/${checks}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`冒烟测试通过：${checks} 项`)

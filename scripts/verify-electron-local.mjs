// 预演「点启动」：用桌面版自带的那份运行时（app.asar 里的 DSH + Electron Node 模式），
// 走本插件真实的 lib/ 代码把本机实例跑起来，再经镜像端点把它的 UI 取回来。
//
// 与 verify-live 的区别：那边起的是一个完整的 DSH 宿主，本机实例跑在普通 node 上；
// 这里不宿主、只预演"首次点击"这一条路径，而且用的是 Electron / asar 这一套——
// 也就是你真正会遇到的配置。
//
//   node scripts/verify-electron-local.mjs [--app <DeepSeek Harness.exe>] [--keep]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const keep = args.includes('--keep')

/**
 * 桌面版安装路径：默认按 Windows 的标准安装位置推（`%LOCALAPPDATA%\Programs\DeepSeek Harness`），
 * 装在别处就 `--app "<...>\DeepSeek Harness.exe"` 指一下。
 */
const defaultAppPath = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Programs',
  'DeepSeek Harness',
  'DeepSeek Harness.exe',
)

const appPath = argOf('app', defaultAppPath)
const installation = dirname(appPath)
const asarEntry = join(installation, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const dshHome = join(tmpdir(), 'dsh-remote-desks-rehearsal')
const profile = 'mirror-electron-rehearsal'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

function get(url, headers = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url)
    const request = httpRequest(
      { hostname: parsed.hostname, port: parsed.port, path: `${parsed.pathname}${parsed.search}`, headers },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, text, headers: response.headers }))
      },
    )
    request.on('error', rejectPromise)
    request.end()
  })
}

async function main() {
  console.log('\n[预演] 桌面版自带运行时 + Electron Node 模式（本机实例的首次点击路径）')
  console.log(`  app       = ${appPath}`)
  console.log(`  asar 入口 = ${asarEntry}`)
  console.log(`  DSH_HOME  = ${dshHome}（临时，跑完清理）`)

  if (!existsSync(appPath)) {
    console.log('  跳过：没找到桌面应用（可用 --app 指定）')
    return
  }

  const spec = await import(pathToFileURL(resolve(root, 'lib/instances/spec.js')).href)
  const readiness = await import(pathToFileURL(resolve(root, 'lib/instances/readiness.js')).href)
  const { MirrorEndpoint } = await import(pathToFileURL(resolve(root, 'lib/mirror/endpoint.js')).href)
  const { tcpUpstream } = await import(pathToFileURL(resolve(root, 'lib/mirror/upstream.js')).href)

  const instance = {
    id: 'electron-rehearsal',
    kind: 'local',
    enabled: true,
    label: '预演实例',
    profile,
    cwd: root,
    jumpHosts: [],
  }
  const runtime = { entry: asarEntry, execPath: appPath, electron: true }

  // 用真实的 localSpec 构造启动计划（这一步就会创建 profile）
  const plan = spec.planFor(instance, runtime, dshHome)
  check('planFor 走进程传输', plan.transport === 'process', plan.transport)
  const launch = plan.spec
  check('argv 用 Electron 可执行文件', launch.argv[0] === appPath, launch.argv[0])
  check('argv 带 --expose-internals', launch.argv.includes('--expose-internals'))
  check('argv 指向 asar 内的发行版', launch.argv.some((value) => value.includes('app.asar') && value.endsWith('bin.js')))
  check('argv 用独立 profile', launch.argv.join(' ').includes(`--profile ${profile}`))
  check('argv 让系统分配端口', launch.argv.join(' ').includes('--port 0'))
  check('env 打开 Electron Node 模式', launch.env.ELECTRON_RUN_AS_NODE === '1')
  check('env 指向临时 DSH_HOME', launch.env.DSH_HOME === dshHome, String(launch.env.DSH_HOME))
  check('env 不继承 DSH_PROFILE', launch.env.DSH_PROFILE === undefined, String(launch.env.DSH_PROFILE))
  check('profile 已由启动器创建', existsSync(join(dshHome, 'profiles', profile, 'package.json')))

  console.log('\n[启动] 用同一份 argv / env / cwd 起进程（与 ctx.subprocess.spawn 收到的一致）')
  const child = spawn(launch.argv[0], launch.argv.slice(1), {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const deadline = Date.now() + 90_000
  let readyUrl
  while (Date.now() < deadline) {
    await wait(400)
    readyUrl = readiness.findReadyUrl(stdout)
    if (readyUrl !== undefined || child.exitCode !== null) break
  }

  let endpoint
  try {
    check('实例打印就绪行', readyUrl !== undefined, readyUrl ?? stderr.trim().split('\n').slice(-2).join(' / '))
    if (readyUrl === undefined) return

    const remotePort = Number(new URL(readyUrl).port)
    check('就绪行带端口', Number.isSafeInteger(remotePort) && remotePort > 0, String(remotePort))

    const exchanged = await readiness.exchangeSession(readyUrl)
    check('会话 cookie 换取成功', exchanged.ok && exchanged.cookie !== undefined, exchanged.detail)

    endpoint = new MirrorEndpoint({
      instanceId: instance.id,
      remotePort,
      connector: tcpUpstream('127.0.0.1', remotePort, 'local'),
      cookie: () => exchanged.cookie,
      bindHost: '127.0.0.1',
      port: 0,
      onLog: (message) => console.log(`  · ${message}`),
    })
    const info = await endpoint.start()
    check('镜像端点起在本机回环', info.baseUrl.startsWith('http://127.0.0.1:'), info.baseUrl)

    const noTicket = await get(info.baseUrl)
    check('无票据访问被拒（403）', noTicket.status === 403, String(noTicket.status))

    const ticketExchange = await get(info.entryUrl)
    const cookie = (ticketExchange.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; ')
    check('票据换 cookie（302）', ticketExchange.status === 302, String(ticketExchange.status))

    const mirrored = await get(info.baseUrl, { cookie })
    check('经镜像取到远端 UI（200）', mirrored.status === 200, String(mirrored.status))
    check('内容确实是 DSH 前端', mirrored.text.includes('__DSH_BOOT__'), `长度 ${String(mirrored.text.length)}`)

    const asset = /"url":"(plugins\/[^"]*)"/.exec(mirrored.text)?.[1]?.replace(/&amp;/g, '&')
    if (asset === undefined) {
      check('镜像里有子资源 url', false)
    } else {
      const bundle = await get(`${info.baseUrl}${asset}`, { cookie })
      check('子资源经镜像可取（200）', bundle.status === 200, String(bundle.status))
    }
  } finally {
    child.kill('SIGTERM')
    await wait(1200)
    if (child.exitCode === null) child.kill('SIGKILL')
    await endpoint?.close().catch(() => undefined)
    if (!keep) rmSync(dshHome, { recursive: true, force: true })
  }
}

await main()

console.log('')
if (failures.length > 0) {
  console.error(`预演失败：${failures.length} 项`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('预演通过：桌面版自带运行时这条路径可以完整走通')

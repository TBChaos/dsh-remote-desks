// 活体验证：起一个真实的 DSH web 实例（独立 profile），确认插件在真实 Loader 树里
// 挂上了控制接口、客户端 bundle 进了 boot 图，并且闸门在真实服务器上生效。
//
// 这就是 M1「拉起一个本机实例」的最小原型：同一套启动/就绪/清理逻辑。
//
//   node scripts/verify-live.mjs [--profile m0-test] [--port 19401] [--keep-profile]
//
// 依赖：仓库里的 @deepseek-ai/dsh（devDependency）提供 CLI 入口，pnpm 用 DSH 运行时自带的。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const profile = argOf('profile', 'm0-test')
const port = Number(argOf('port', '19401'))
const keepProfile = args.includes('--keep-profile')
const pnpmEntry = argOf('pnpm', process.env.DSH_PNPM_ENTRY ?? '')
const nodeBin = argOf('node', process.execPath)

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const profileDir = join(dshHome, 'profiles', profile)

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

function dshEntry() {
  return require.resolve('@deepseek-ai/dsh/lib/bin.js')
}

/** 准备一个与 desktop 同构的 profile：dsh-base + dsh-web-app + 本插件（link 安装）。 */
function prepareProfile() {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profile}`,
        private: true,
        dependencies: { 'dsh-remote-desks': `link:${root.replace(/\\/g, '/')}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-desks'] } },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    `# ${profile}：由 scripts/verify-live.mjs 生成的临时 profile。\n[]\n`,
  )
  const workspace = join(root, 'pnpm-workspace.yaml')
  if (existsSync(workspace)) writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), readFileSync(workspace))
}

function installProfile() {
  if (pnpmEntry === '') {
    console.log('  跳过 pnpm install（未提供 --pnpm / DSH_PNPM_ENTRY）')
    return
  }
  const result = spawnSync(nodeBin, [pnpmEntry, 'install', '--dir', profileDir], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`pnpm install 失败（退出码 ${String(result.status)}）`)
  }
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * 用 node:http 而不是 fetch —— fetch 会把 `host` 当禁止头名丢掉，伪造不出来。
 * 这里要验的正是 Host 校验，所以必须能自己写 Host。
 */
function httpGet(url, headers = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url)
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          resolvePromise({ status: response.statusCode ?? 0, text, headers: response.headers })
        })
      },
    )
    request.on('error', rejectPromise)
    request.end()
  })
}

async function main() {
  console.log(`\n[prepare] profile=${profile} port=${String(port)}`)
  prepareProfile()
  installProfile()

  const entry = dshEntry()
  console.log(`[boot] ${entry} --profile ${profile} --port ${String(port)} --no-open`)
  const child = spawn(nodeBin, [entry, '--profile', profile, '--port', String(port), '--no-open'], {
    cwd: profileDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: dshHome },
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
  let ready = false
  while (Date.now() < deadline) {
    await wait(500)
    if (/dsh web: /.test(stdout)) {
      ready = true
      break
    }
    if (child.exitCode !== null) break
  }

  try {
    check('实例启动并打印就绪行', ready)
    if (!ready) {
      console.log(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
      return
    }
    if (stderr.trim() !== '') console.log(`  (stderr) ${stderr.trim().split('\n').slice(0, 4).join('\n  ')}`)

    const base = `http://127.0.0.1:${String(port)}`
    const token = /token=([\w-]+)/.exec(stdout)?.[1]
    check('就绪行带 token', typeof token === 'string' && token.length > 0)

    // 裸请求必须被拒：控制接口叠加了官方信任判定，没有会话 cookie 一律挡掉。
    const anonymous = await httpGet(`${base}/remote-desks/api/state`)
    check(
      '无 cookie 的裸请求被拒（401/403）',
      anonymous.status === 401 || anonymous.status === 403,
      String(anonymous.status),
    )

    // token 换 cookie：303 + Set-Cookie，之后控制接口与 index 都靠它。
    const exchange = await httpGet(`${base}/?token=${String(token)}`)
    const cookie = (exchange.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; ')
    check('token 换到了会话 cookie', cookie !== '', String(exchange.status))

    const state = await httpGet(`${base}/remote-desks/api/state`, { cookie })
    check('带 cookie 的 GET /remote-desks/api/state → 200', state.status === 200, String(state.status))
    let report
    try {
      report = JSON.parse(state.text)
    } catch {
      report = undefined
    }
    check('状态体是合法 JSON', report !== undefined)
    check('报告含 webServer 服务', report?.services?.webServer === true)
    check('闸门已生效', typeof report?.control?.gate === 'string', String(report?.control?.gate))

    const forged = await httpGet(`${base}/remote-desks/api/state`, { cookie, host: '10.1.2.3:19401' })
    check('伪造非回环 Host → 403', forged.status === 403, String(forged.status))

    const index = await httpGet(`${base}/`, { cookie })
    check('index 含本插件的 boot 行', index.text.includes('dsh-remote-desks'))

    const url = /"url":"([^"]*dsh-remote-desks[^"]*)"/.exec(index.text)?.[1]
    check('boot 图给出 bundle url', typeof url === 'string' && url.length > 0, String(url))
    if (typeof url === 'string') {
      const bundle = await httpGet(`${base}/${url}`, { cookie })
      check('客户端 bundle 可取', bundle.status === 200, String(bundle.status))
      check('bundle 是 __ModuleLoader__ 形态', bundle.text.startsWith('window.__ModuleLoader__.load({'))
      check('bundle 内模块 id 正确', bundle.text.includes('"dsh-remote-desks"'))
      check('bundle 体积合理', bundle.text.length > 2000, String(bundle.text.length))
    }
  } finally {
    child.kill('SIGTERM')
    await wait(1200)
    if (child.exitCode === null) child.kill('SIGKILL')
    if (!keepProfile) {
      try {
        rmSync(profileDir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }
}

await main()

console.log('')
if (failures.length > 0) {
  console.error(`活体验证失败：${failures.length} 项`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('活体验证通过')

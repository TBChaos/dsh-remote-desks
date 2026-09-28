// 活体验证：起一个真实的 DSH web 宿主（临时 profile），在它里面跑本插件，
// 然后驱动插件拉起真实的「本机实例」和（可选）「WSL 实例」，并通过镜像端点访问它们的 UI。
//
//   node scripts/verify-live.mjs [--profile m0-test] [--port 19401] [--keep-profile]
//                               [--pnpm <pnpm.mjs>] [--node <node.exe>] [--wsl <distro>]
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
const wslDistro = argOf('wsl', '')
const sshMode = args.includes('--ssh')
const sshPort = Number(argOf('ssh-port', '12222'))
const sshPassword = argOf('ssh-password', 'dsh-remote-desks-test')
const sshCredentialRef = 'DSH_REMOTE_DESKS_TEST_SSH_PASSWORD'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const localInstanceProfile = 'mirror-m1-local'
const wslInstanceProfile = 'mirror-m1-wsl'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

function dshEntry() {
  return require.resolve('@deepseek-ai/dsh/lib/bin.js')
}

/** 与 desktop 同构的 profile：dsh-base + dsh-web-app + 本插件，并声明待启动的实例。 */
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
  const instances = [
    `      - id: m1-local`,
    `        kind: local`,
    `        profile: ${localInstanceProfile}`,
    `        cwd: ${JSON.stringify(root)}`,
  ]
  if (wslDistro !== '') {
    instances.push(`      - id: m1-wsl`, `        kind: wsl`, `        distro: ${wslDistro}`, `        cwd: /home/zmh`)
  }
  if (sshMode) {
    instances.push(
      `      - id: m2-ssh`,
      `        kind: ssh`,
      `        host: 127.0.0.1`,
      `        port: ${String(sshPort)}`,
      `        username: dsh-test`,
      `        cwd: /home/zmh`,
      `        auth:`,
      `          method: password`,
      `          passwordCredential: ${sshCredentialRef}`,
    )
  }
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      `# ${profile}：由 scripts/verify-live.mjs 生成的临时 profile。`,
      `# 覆盖本插件那一行的 config（patch 会替换整块 config，所以每个键都要重申）。`,
      `- id: remote-desks`,
      `  config:`,
      `    instances:`,
      ...instances,
      `    autoStart: ['m1-local']`,
      `    mirror: { host: 127.0.0.1, portRange: [19500, 19510], openMode: auto }`,
      `    announce: true`,
      '',
    ].join('\n'),
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

/**
 * 用 node:http 而不是 fetch —— fetch 会把 `host` 当禁止头名丢掉，伪造不出来。
 * 这里要验的正是 Host 校验，所以必须能自己写 Host。
 */
function httpRequestOnce(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url)
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
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

const get = (url, headers) => httpRequestOnce(url, { headers })
const post = (url, headers) => httpRequestOnce(url, { method: 'POST', headers })
const cookieOf = (headers) => (headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; ')

async function awaitPhase(base, cookie, id, phase, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const response = await get(`${base}/remote-desks/api/instances/${id}`, { cookie })
      last = JSON.parse(response.text)
      if (last.phase === phase) return last
      if (last.phase === 'error' && phase !== 'error') return last
    } catch {
      // 宿主可能正在收尾；继续轮询直到超时
    }
    await wait(1000)
  }
  return last
}

function dumpLogs(snapshot) {
  console.log(`  (实例日志)\n    ${(snapshot?.logs?.lines ?? []).slice(-14).join('\n    ')}`)
}

/** 对一个**已在运行**的实例做完整镜像往返：票据闸门 → 票据换 cookie → 镜像 UI → 子资源。 */
async function verifyMirrorOf(running, id) {
  if (running?.phase !== 'running') {
    check(`${id} 镜像往返（需 running）`, false, String(running?.phase))
    return
  }
  const noTicket = await get(running.mirrorBaseUrl)
  check(`${id} 镜像端点无票据 → 403`, noTicket.status === 403, String(noTicket.status))

  const ticketExchange = await get(running.mirrorEntryUrl)
  check(`${id} 票据换 cookie → 302`, ticketExchange.status === 302, String(ticketExchange.status))
  const mirrorCookie = cookieOf(ticketExchange.headers)
  check(`${id} 发出了票据 cookie`, mirrorCookie.includes('dsh_mirror='), mirrorCookie)

  const mirrored = await get(running.mirrorBaseUrl, { cookie: mirrorCookie })
  check(`${id} 带票据取到被镜像的 UI`, mirrored.status === 200, String(mirrored.status))
  check(`${id} 镜像内容是 DSH 前端`, mirrored.text.includes('__DSH_BOOT__'), `长度 ${String(mirrored.text.length)}`)
  // 锋利的判据：宿主自己的 boot 图里有本插件，实例的没有——"不含本插件行"正好证明
  // 拿到的是另一个实例的 UI，而不是本地的。
  check(`${id} 镜像是另一个实例（不含本插件行）`, !mirrored.text.includes('dsh-remote-desks'))
  check(`${id} 镜像含实例自己的标准客户端行`, mirrored.text.includes('dsh-client-ui-conversation'))
  if (mirrored.status !== 200) console.log(`  (镜像响应)\n    ${mirrored.text.slice(0, 300)}`)

  // 子资源的 URL 形态随远端版本略有差异（组合式 `plugins/??<id>/client.js&rev=…`
  // 与单资源式都见过），所以两种都认；真的一处都没有就打印证据而不是直接判失败。
  const assetMatch =
    /"url":"(plugins\/[^"]*)"/.exec(mirrored.text) ?? /(plugins\/\?\?[^"'\s]+)/.exec(mirrored.text)
  if (assetMatch === null) {
    const at = mirrored.text.indexOf('plugins/')
    check(`${id} 镜像 index 里能找到子资源 url`, false, at === -1 ? '整份 index 未出现 plugins/' : mirrored.text.slice(Math.max(0, at - 120), at + 120))
  } else {
    // index 里的 URL 是 HTML 文本，`&` 会被转义成 `&amp;`，取资源前必须还原。
    const assetPath = assetMatch[1].replace(/&amp;/g, '&').replace(/&#38;/g, '&')
    const asset = await get(`${running.mirrorBaseUrl}${assetPath}`, { cookie: mirrorCookie })
    check(`${id} 镜像里的子资源可取`, asset.status === 200, String(asset.status))
    check(`${id} 子资源是客户端 bundle`, asset.text.startsWith('window.__ModuleLoader__.load({'))
  }

  const badTicket = await get(`${running.mirrorBaseUrl}?k=wrong`)
  check(`${id} 错误票据 → 403`, badTicket.status === 403, String(badTicket.status))
}

async function main() {
  console.log(`\n[prepare] profile=${profile} port=${String(port)} wsl=${wslDistro === '' ? '（跳过）' : wslDistro} ssh=${sshMode ? `127.0.0.1:${String(sshPort)}` : '（跳过）'}`)

  // M2：起一个测试用 SSH 对端（exec 与隧道都转给 WSL），让 SSH 腿也能真的跑起来。
  let sshServer
  if (sshMode) {
    sshServer = spawn(nodeBin, [join(root, 'scripts', 'ssh-test-server.mjs'), '--port', String(sshPort), '--password', sshPassword, '--distro', wslDistro === '' ? 'Ubuntu-24.04' : wslDistro], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let banner = ''
    sshServer.stdout.setEncoding('utf8')
    sshServer.stderr.setEncoding('utf8')
    sshServer.stdout.on('data', (chunk) => {
      banner += chunk
    })
    const deadlineAt = Date.now() + 20_000
    while (Date.now() < deadlineAt && !banner.includes('监听')) await wait(200)
    check('测试 SSH 对端已就绪', banner.includes('监听'), banner.trim().split('\n').slice(-1)[0] ?? '')
  }

  prepareProfile()
  installProfile()

  const entry = dshEntry()
  console.log(`[boot] ${entry} --profile ${profile} --port ${String(port)} --no-open`)
  const child = spawn(nodeBin, [entry, '--profile', profile, '--port', String(port), '--no-open'], {
    cwd: profileDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 凭据走"环境变量引用"这条路，不去写用户的凭据库。
    env: { ...process.env, DSH_HOME: dshHome, [sshCredentialRef]: sshPassword },
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
    check('宿主启动并打印就绪行', ready)
    if (!ready) {
      console.log(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
      return
    }
    if (stderr.trim() !== '') console.log(`  (stderr) ${stderr.trim().split('\n').slice(0, 4).join('\n  ')}`)

    const base = `http://127.0.0.1:${String(port)}`
    const token = /token=([\w-]+)/.exec(stdout)?.[1]
    check('就绪行带 token', typeof token === 'string' && token.length > 0)

    /* ── M0：鉴权、boot 图、bundle ── */
    console.log('\n[M0] 控制接口与客户端 bundle')
    const anonymous = await get(`${base}/remote-desks/api/state`)
    check('无 cookie 的裸请求被拒（401/403）', anonymous.status === 401 || anonymous.status === 403, String(anonymous.status))

    const exchange = await get(`${base}/?token=${String(token)}`)
    const cookie = cookieOf(exchange.headers)
    check('token 换到了会话 cookie', cookie !== '', String(exchange.status))

    const state = await get(`${base}/remote-desks/api/state`, { cookie })
    check('带 cookie 的 GET /api/state → 200', state.status === 200, String(state.status))
    const report = JSON.parse(state.text)
    check('报告含 webServer 服务', report?.services?.webServer === true)
    check('报告含 subprocess 服务', report?.services?.subprocess === true)
    check('闸门已生效', typeof report?.control?.gate === 'string', String(report?.control?.gate))
    check(
      '本机运行时取自宿主自己那份（argv[1] 策略）',
      report?.runtime?.via === 'process.argv[1]',
      `${String(report?.runtime?.via)} → ${String(report?.runtime?.root)}`,
    )
    check('配置里看得到实例', report?.config?.instances >= 1, String(report?.config?.instances))

    const forged = await get(`${base}/remote-desks/api/state`, { cookie, host: '10.1.2.3:19401' })
    check('伪造非回环 Host → 403', forged.status === 403, String(forged.status))

    const index = await get(`${base}/`, { cookie })
    check('index 含本插件的 boot 行', index.text.includes('dsh-remote-desks'))
    const url = /"url":"([^"]*dsh-remote-desks[^"]*)"/.exec(index.text)?.[1]
    check('boot 图给出 bundle url', typeof url === 'string' && url.length > 0, String(url))
    if (typeof url === 'string') {
      const bundle = await get(`${base}/${url}`, { cookie })
      check('客户端 bundle 可取', bundle.status === 200, String(bundle.status))
      check('bundle 是 __ModuleLoader__ 形态', bundle.text.startsWith('window.__ModuleLoader__.load({'))
    }

    /* ── M1/M2：多实例并发 ── */
    const targets = ['m1-local']
    if (wslDistro !== '') targets.push('m1-wsl')
    if (sshMode) targets.push('m2-ssh')

    /* ── 预检：不启动实例就能看清缺什么 ── */
    console.log('\n[预检] 静态检查（不拉起实例）')
    for (const id of targets) {
      const checked = await get(`${base}/remote-desks/api/instances/${id}/check`, { cookie })
      check(`${id} 预检 → 200`, checked.status === 200, String(checked.status))
      let items = []
      try {
        items = JSON.parse(checked.text)?.checks ?? []
      } catch {
        items = []
      }
      check(`${id} 预检有明细`, items.length > 0, items.map((item) => `${item.name}:${item.ok ? 'ok' : 'x'}`).join(', '))
      // 配置本身正确，所以除了"运行时/远端环境"这类环境项，其余都应当通过。
      const failed = items.filter((item) => !item.ok)
      console.log(`  · ${id} 预检：${items.length} 项，未通过 ${String(failed.length)} 项${failed.length === 0 ? '' : `（${failed.map((item) => item.name).join('、')}）`}`)
    }
    const unknown = await get(`${base}/remote-desks/api/instances/nope/check`, { cookie })
    check('预检未知实例 → 404', unknown.status === 404, String(unknown.status))

    /* ── 并发启动 ── */
    console.log(`\n[并发] 同时拉起 ${String(targets.length)} 个实例：${targets.join('、')}`)
    // m1-local 在 autoStart 里：不点任何按钮，它应该自己起来。
    const autoStarted = await awaitPhase(base, cookie, 'm1-local', 'running', 120_000)
    check('autoStart 让实例自己起来', autoStarted?.phase === 'running', `${String(autoStarted?.phase)}：${String(autoStarted?.detail)}`)
    if (autoStarted?.phase !== 'running') dumpLogs(autoStarted)

    for (const id of targets.filter((entry) => entry !== 'm1-local')) {
      const started = await post(`${base}/remote-desks/api/instances/${id}/start`, { cookie }).catch((error) => ({
        status: 0,
        text: String(error),
      }))
      check(`${id} POST start → 200`, started.status === 200, String(started.status))
    }

    // 先把所有实例都等到 running，再逐个验镜像——这样"同时在线"才是真的被验到。
    const running = {}
    for (const id of targets) {
      running[id] = await awaitPhase(base, cookie, id, 'running')
      check(`${id} 进入 running`, running[id]?.phase === 'running', `${String(running[id]?.phase)}：${String(running[id]?.detail)}`)
      if (running[id]?.phase !== 'running') dumpLogs(running[id])
    }
    const concurrent = targets.filter((id) => running[id]?.phase === 'running')
    check('多个实例同时处于 running', concurrent.length === targets.length, `${String(concurrent.length)}/${String(targets.length)}`)
    const ports = concurrent.map((id) => running[id]?.remotePort)
    check('各实例端口互不相同', new Set(ports).size === ports.length, ports.join(', '))
    const mirrorPorts = concurrent.map((id) => running[id]?.mirrorBaseUrl)
    check('各镜像端点端口互不相同', new Set(mirrorPorts).size === mirrorPorts.length, mirrorPorts.join(', '))
    // 配置把镜像端口限定在 19500-19510，所以端点应当落在范围内（而不是交给操作系统随便挑）。
    const portNumbers = concurrent.map((id) => Number(new URL(running[id].mirrorBaseUrl).port))
    check(
      '镜像端口落在配置的 portRange 内',
      portNumbers.every((port) => port >= 19500 && port <= 19510),
      portNumbers.join(', '),
    )

    const list = await get(`${base}/remote-desks/api/instances`, { cookie })
    const listed = JSON.parse(list.text)?.instances ?? []
    check(
      '列表里所有实例都在 running',
      targets.every((id) => listed.find((entry) => entry.id === id)?.phase === 'running'),
      listed.map((entry) => `${entry.id}:${entry.phase}`).join(', '),
    )

    for (const id of targets) await verifyMirrorOf(running[id], id)

    // restart：应当换一个新端口重新起来（旧端点收摊、旧进程退出）。
    const beforeRestart = running['m1-local']?.remotePort
    const restarted = await post(`${base}/remote-desks/api/instances/m1-local/restart`, { cookie })
    check('POST restart → 200', restarted.status === 200, String(restarted.status))
    const afterRestart = await awaitPhase(base, cookie, 'm1-local', 'running', 120_000)
    check('restart 后回到 running', afterRestart?.phase === 'running', `${String(afterRestart?.phase)}：${String(afterRestart?.error ?? afterRestart?.detail)}`)
    if (afterRestart?.phase !== 'running') dumpLogs(afterRestart)
    check(
      'restart 换了一个远端端口',
      typeof afterRestart?.remotePort === 'number' && afterRestart.remotePort !== beforeRestart,
      `${String(beforeRestart)} → ${String(afterRestart?.remotePort)}`,
    )
    if (afterRestart?.phase === 'running') await verifyMirrorOf(afterRestart, 'm1-local(restart 后)')

    /* ── 耐久：连续启停 ── */
    const CYCLES = 5
    console.log(`\n[耐久] m1-local 连续启停 ${String(CYCLES)} 轮`)
    let previousPort = afterRestart?.remotePort
    let soakFailures = 0
    for (let round = 1; round <= CYCLES; round += 1) {
      await post(`${base}/remote-desks/api/instances/m1-local/stop`, { cookie })
      const stoppedRound = await awaitPhase(base, cookie, 'm1-local', 'stopped', 30_000)
      if (stoppedRound?.phase !== 'stopped') {
        soakFailures += 1
        console.log(`  FAIL 第 ${String(round)} 轮停止 — ${String(stoppedRound?.phase)}`)
        break
      }
      await post(`${base}/remote-desks/api/instances/m1-local/start`, { cookie })
      const runningRound = await awaitPhase(base, cookie, 'm1-local', 'running', 120_000)
      if (runningRound?.phase !== 'running') {
        soakFailures += 1
        console.log(`  FAIL 第 ${String(round)} 轮启动 — ${String(runningRound?.phase)}：${String(runningRound?.error)}`)
        dumpLogs(runningRound)
        break
      }
      const endpointAlive = await get(runningRound.mirrorBaseUrl)
      const okPort = runningRound.remotePort !== previousPort
      const okEndpoint = endpointAlive.status === 403
      console.log(
        `  · 第 ${String(round)} 轮：端口 ${String(runningRound.remotePort)}（换端口 ${okPort ? '是' : '否'}）｜镜像端点 ${String(endpointAlive.status)}`,
      )
      if (!okPort || !okEndpoint) soakFailures += 1
      previousPort = runningRound.remotePort
    }
    check(`连续启停 ${String(CYCLES)} 轮无异常`, soakFailures === 0, `异常 ${String(soakFailures)} 轮`)

    if (sshMode) {
      const sshRunning = running['m2-ssh']
      if (sshRunning?.upstream !== undefined) {
        check('SSH 上游是隧道', String(sshRunning.upstream).includes('ssh-forward'), String(sshRunning.upstream))
      }
      const sshLogs = await get(`${base}/remote-desks/api/instances/m2-ssh/logs?offset=0`, { cookie }).catch(() => ({ text: '{}' }))
      const lines = JSON.parse(sshLogs.text)?.lines ?? []
      check('日志里有 SSH 连接', lines.some((line) => line.includes('SSH 已连接')), lines.slice(0, 2).join(' | '))
      check('日志里记了主机密钥指纹', lines.some((line) => line.includes('SHA256:')), '')
    }

    console.log('\n[停止] 逐个停止并确认收摊')
    for (const id of targets) {
      const stopped = await post(`${base}/remote-desks/api/instances/${id}/stop`, { cookie })
      check(`${id} POST stop → 200`, stopped.status === 200, String(stopped.status))
      const after = await awaitPhase(base, cookie, id, 'stopped', 30_000)
      check(`${id} 回到 stopped`, after?.phase === 'stopped', String(after?.phase))
      check(`${id} 停止后不再暴露镜像端点`, after?.mirrorBaseUrl === undefined, String(after?.mirrorBaseUrl))
    }

    const logs = await get(`${base}/remote-desks/api/instances/m1-local/logs?offset=0`, { cookie })
    check('实例日志可读', (JSON.parse(logs.text)?.lines ?? []).length > 0)
  } finally {
    if (failures.length > 0) {
      const tail = stderr.trim().split('\n').slice(-18).join('\n  ')
      console.log(`  (宿主 stderr 末尾)\n  ${tail === '' ? '（空）' : tail}`)
      const outTail = stdout.trim().split('\n').slice(-6).join('\n  ')
      console.log(`  (宿主 stdout 末尾)\n  ${outTail === '' ? '（空）' : outTail}`)
    }
    child.kill('SIGTERM')
    await wait(1500)
    if (child.exitCode === null) child.kill('SIGKILL')
    if (sshServer !== undefined) {
      sshServer.kill('SIGTERM')
      await wait(300)
      if (sshServer.exitCode === null) sshServer.kill('SIGKILL')
    }
    if (!keepProfile) {
      for (const dir of [profileDir, join(dshHome, 'profiles', localInstanceProfile), join(dshHome, 'profiles', wslInstanceProfile)]) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 清理失败不影响结论 */
        }
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

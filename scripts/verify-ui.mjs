// 真实浏览器里的界面验证：起一个宿主（本插件 + 一个本机实例），用 Electron
// （与桌面应用同一套 Chromium）打开真实界面，点开面板、点启动、等镜像渲染，最后截图。
//
//   node scripts/verify-ui.mjs [--port 19411] [--out .recon/ui] [--keep] [--no-start]
//
// 需要 devDependency 里的 electron；没装二进制就跳过（不让验证脚本变成硬依赖）。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const port = Number(argOf('port', '19411'))
const outDir = resolve(root, argOf('out', '.recon/ui'))
const keep = args.includes('--keep')
const skipStart = args.includes('--no-start')
const pnpmEntry = argOf('pnpm', process.env.DSH_PNPM_ENTRY ?? '')
const nodeBin = argOf('node', process.execPath)

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const profile = 'ui-verify'
const profileDir = join(dshHome, 'profiles', profile)
const instanceProfile = 'mirror-ui-verify'
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

function electronBinary() {
  try {
    const value = require('electron')
    if (typeof value === 'string' && existsSync(value)) return value
  } catch {
    /* 没装 */
  }
  const fallback = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  return existsSync(fallback) ? fallback : undefined
}

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
    [
      `# ${profile}：由 scripts/verify-ui.mjs 生成的临时 profile。`,
      `- id: remote-desks`,
      `  config:`,
      `    instances:`,
      `      - id: ui-local`,
      `        kind: local`,
      `        label: 本机预演实例`,
      `        profile: ${instanceProfile}`,
      `        cwd: ${JSON.stringify(root)}`,
      `    autoStart: []`,
      `    mirror: { host: 127.0.0.1, portRange: [19600, 19610], openMode: auto }`,
      `    announce: true`,
      '',
    ].join('\n'),
  )
  const workspace = join(root, 'pnpm-workspace.yaml')
  if (existsSync(workspace)) writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), readFileSync(workspace))
}

async function main() {
  const electron = electronBinary()
  if (electron === undefined) {
    console.log('跳过 UI 验证：没找到 electron 二进制（pnpm install 时允许 electron 的构建脚本即可）')
    return
  }
  console.log(`\n[准备] profile=${profile} port=${String(port)} electron=${electron}`)
  prepareProfile()
  if (pnpmEntry !== '') {
    const install = spawnSync(nodeBin, [pnpmEntry, 'install', '--dir', profileDir], { encoding: 'utf8' })
    if (install.status !== 0) {
      console.error(install.stdout, install.stderr)
      throw new Error('pnpm install 失败')
    }
  }

  const entry = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  const host = spawn(nodeBin, [entry, '--profile', profile, '--port', String(port), '--no-open'], {
    cwd: profileDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: dshHome },
  })
  let stdout = ''
  host.stdout.setEncoding('utf8')
  host.stderr.setEncoding('utf8')
  host.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  host.stderr.on('data', (chunk) => {
    process.stderr.write(`[host] ${chunk}`)
  })

  const deadline = Date.now() + 90_000
  let readyUrl
  while (Date.now() < deadline) {
    await wait(500)
    readyUrl = /dsh web:\s*(https?:\/\/\S+)/.exec(stdout)?.[1]
    if (readyUrl !== undefined || host.exitCode !== null) break
  }

  try {
    if (readyUrl === undefined) {
      console.log('宿主没起来，无法做 UI 验证')
      return
    }
    console.log(`[宿主] ${readyUrl.replace(/token=.*/, 'token=***')}`)
    console.log('[浏览器] 打开真实界面并驱动面板…')

    // 我们这个 shell 从 DSH 宿主继承了 ELECTRON_RUN_AS_NODE=1；Electron 只看这个变量
    // **是否存在**（空字符串也算），所以必须真删掉，否则它会以 Node 模式启动、根本不开窗口。
    const electronEnv = { ...process.env, UI_URL: readyUrl, UI_OUT: outDir, UI_INSTANCE: '本机预演实例' }
    delete electronEnv.ELECTRON_RUN_AS_NODE
    if (skipStart) electronEnv.UI_SKIP_START = '1'

    const child = spawn(electron, [join(root, 'scripts', 'ui-verify', 'main.cjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: electronEnv,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`))

    const exitCode = await new Promise((resolvePromise) => child.on('close', resolvePromise))
    console.log(`\n[浏览器] 退出码 ${String(exitCode)}｜产物在 ${outDir}`)

    const resultsPath = join(outDir, 'results.json')
    if (existsSync(resultsPath)) {
      const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
      const failed = (results.steps ?? []).filter((step) => !step.ok)
      if (failed.length > 0) {
        console.error(`UI 验证失败：${String(failed.length)} 项`)
        for (const step of failed) console.error(`  - ${step.name} — ${step.detail}`)
        process.exitCode = 1
      } else {
        console.log(`UI 验证通过：${String(results.steps.length)} 项`)
      }
    }
  } finally {
    host.kill('SIGTERM')
    await wait(1200)
    if (host.exitCode === null) host.kill('SIGKILL')
    if (!keep) {
      for (const dir of [profileDir, join(dshHome, 'profiles', instanceProfile)]) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 忽略 */
        }
      }
    }
  }
}

await main()

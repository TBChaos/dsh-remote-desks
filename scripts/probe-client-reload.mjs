// 一次性实测：宿主是"每次请求都读 client.js"还是"启动时缓存"。
//
// 结论会决定：改完客户端那半边，用户按 Ctrl+R 刷新窗口够不够，还是必须重启应用。
// 做法：起一个临时宿主 → 取到客户端 bundle 的地址与内容 → 往 lib/client.js 追加一个标记
// → 再取一次 → 比较 → 恢复文件。
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const nodeBin = argOf('node', process.execPath)
const pnpmEntry = argOf('pnpm', '')
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
const profile = 'client-reload-probe'
const profileDir = join(dshHome, 'profiles', profile)
const clientFile = join(root, 'lib', 'client.js')
const marker = `\n// reload-probe-${String(Date.now())}\n`
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

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
writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: remote-desks\n  config:\n    announce: false\n')
const workspace = join(root, 'pnpm-workspace.yaml')
if (existsSync(workspace)) writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), readFileSync(workspace))
if (pnpmEntry !== '') {
  const install = spawnSync(nodeBin, [pnpmEntry, 'install', '--dir', profileDir], { encoding: 'utf8' })
  if (install.status !== 0) {
    console.error(install.stdout, install.stderr)
    process.exit(1)
  }
}

const entry = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const host = spawn(nodeBin, [entry, '--profile', profile, '--port', '19477', '--no-open'], {
  cwd: profileDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: dshHome },
})
let stdout = ''
host.stdout.setEncoding('utf8')
host.stdout.on('data', (chunk) => {
  stdout += chunk
})
host.stderr.setEncoding('utf8')
host.stderr.on('data', (chunk) => process.stderr.write(`[host] ${chunk}`))

const original = readFileSync(clientFile, 'utf8')
try {
  const deadline = Date.now() + 90_000
  let readyUrl
  while (Date.now() < deadline) {
    await wait(500)
    readyUrl = /dsh web:\s*(https?:\/\/\S+)/.exec(stdout)?.[1]
    if (readyUrl !== undefined || host.exitCode !== null) break
  }
  if (readyUrl === undefined) throw new Error('宿主没起来')

  const exchanged = await fetch(readyUrl, { redirect: 'manual' })
  const cookie = exchanged.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  const origin = new URL(readyUrl).origin
  const index = await (await fetch(`${origin}/`, { headers: { cookie } })).text()

  // 客户端 bundle 的地址写在 __DSH_BOOT__ 里；挑出属于本插件的那一条。
  const urls = [...index.matchAll(/"(?:url|src|entry)"\s*:\s*"([^"]*client[^"]*)"/g)].map((match) => match[1])
  const candidates = urls.length > 0 ? urls : [...index.matchAll(/"(https?:\/\/[^"]*?\.js[^"]*)"/g)].map((m) => m[1])
  console.log(`索引里候选客户端地址 ${String(candidates.length)} 个：${candidates.slice(0, 4).join(', ')}`)
  const bundleUrl = candidates.find((url) => url.includes('remote-desks')) ?? candidates[0]
  if (bundleUrl === undefined) throw new Error('索引里找不到客户端 bundle 地址')

  const absolute = new URL(bundleUrl, `${origin}/`).href
  const first = await (await fetch(absolute, { headers: { cookie } })).text()
  console.log(`第一次取到 ${String(first.length)} 字符｜含 remote-desks：${String(first.includes('remote-desks'))}`)

  appendFileSync(clientFile, marker)
  const second = await (await fetch(absolute, { headers: { cookie } })).text()
  const live = second.includes(marker.trim())

  const restarted = await (async () => {
    host.kill('SIGTERM')
    await wait(1500)
    if (host.exitCode === null) host.kill('SIGKILL')
    return true
  })()
  void restarted

  console.log('')
  console.log(live ? '结论：宿主**每次请求都读文件** → 改客户端只需刷新窗口（Ctrl+R）。' : '结论：宿主**启动时缓存**了客户端内容 → 改客户端也必须重启应用。')
  console.log(`（第二次 ${String(second.length)} 字符，含新标记：${String(live)}）`)
} catch (error) {
  console.error('实测失败：', error)
  process.exitCode = 1
} finally {
  writeFileSync(clientFile, original)
  host.kill('SIGTERM')
  await wait(1200)
  if (host.exitCode === null) host.kill('SIGKILL')
  rmSync(profileDir, { recursive: true, force: true })
  console.log('已恢复 lib/client.js 并清理临时 profile。')
}

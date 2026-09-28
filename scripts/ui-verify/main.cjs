// 真实浏览器验证（由 scripts/verify-ui.mjs 用 Electron 拉起）。
//
// 做法：用与桌面应用同一套 Chromium 打开真实的 DSH 界面（走 token 换 cookie 的正常路径），
// 找到我们的侧栏入口点开面板、点「启动」、等镜像区把远端 UI 渲染出来，然后截图。
//
// 环境变量：UI_URL（带 token 的地址）、UI_OUT（输出目录）、UI_INSTANCE（实例 label 关键字）
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const target = process.env.UI_URL
const outDir = process.env.UI_OUT
const instanceLabel = process.env.UI_INSTANCE ?? '本机'
const skipStart = process.env.UI_SKIP_START === '1'

const results = { steps: [], dom: {} }
const record = (name, ok, detail = '') => {
  results.steps.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

async function main() {
  await app.whenReady()
  fs.mkdirSync(outDir, { recursive: true })

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 940,
    webPreferences: { webviewTag: true, contextIsolation: true, backgroundThrottling: false },
  })
  const wc = win.webContents
  const consoleErrors = []
  wc.on('console-message', (_event, level, message) => {
    const text = String(message)
    // Electron 自己会就 CSP 发一条安全警告，那不是我们代码的问题。
    if (text.includes('Electron Security Warning')) return
    if (level >= 2) consoleErrors.push(text.slice(0, 300))
  })
  wc.on('render-process-gone', (_event, details) => record('渲染进程存活', false, JSON.stringify(details)))

  const js = (code) => wc.executeJavaScript(code, true)
  const shot = async (name) => {
    const image = await wc.capturePage()
    const file = path.join(outDir, `${name}.png`)
    fs.writeFileSync(file, image.toPNG())
    return file
  }
  const waitFor = async (code, timeoutMs = 30_000, label = code.slice(0, 60)) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await js(code)) return true
      } catch {
        /* 页面还在导航 */
      }
      await wait(400)
    }
    record(`等待：${label}`, false, `超时 ${String(timeoutMs)}ms`)
    return false
  }

  // 1. 走正常入口：带 token 打开 → 应用自己换 cookie 并跳转
  await win.loadURL(target)
  await wait(1500)
  record('界面已加载', true, await js('location.pathname + location.search.slice(0, 12)'))

  // 2. 等 shell 挂载
  await waitFor('!!document.querySelector("#root") && document.querySelector("#root").children.length > 0', 30_000, 'shell 挂载')
  await wait(2500)

  // 3. 我们的侧栏入口（先把候选 dump 出来，找不到时也能看清结构）
  const candidates = await js(`
    Array.from(document.querySelectorAll('button,[role="button"]'))
      .map((node) => ({
        label: node.getAttribute('aria-label') ?? '',
        title: node.getAttribute('title') ?? '',
        text: (node.textContent ?? '').trim().slice(0, 24),
        cls: (node.className ?? '').toString().slice(0, 40),
      }))
      .filter((entry) => entry.label !== '' || entry.title !== '' || entry.text !== '')
      .slice(0, 60)
  `)
  results.dom.buttons = candidates
  const entryIndex = candidates.findIndex(
    (entry) => `${entry.label}${entry.title}${entry.text}`.includes('远端工作台') || `${entry.label}${entry.title}`.includes('remote-desks'),
  )
  record('侧栏里找到本插件入口', entryIndex >= 0, entryIndex >= 0 ? JSON.stringify(candidates[entryIndex]) : `${String(candidates.length)} 个候选`)

  if (entryIndex >= 0) {
    await js(`
      (() => {
        const nodes = Array.from(document.querySelectorAll('button,[role="button"]'))
          .filter((node) => {
            const text = (node.getAttribute('aria-label') ?? '') + (node.getAttribute('title') ?? '') + (node.textContent ?? '')
            return text.includes('远端工作台') || text.includes('remote-desks')
          })
        if (nodes.length > 0) { nodes[0].click(); return true }
        return false
      })()
    `)
    await wait(1200)
  }

  // 4. 面板
  const panelUp = await waitFor('!!document.querySelector(".drd-root")', 20_000, '面板出现')
  if (panelUp) {
    const panelText = await js('document.querySelector(".drd-root").innerText')
    results.dom.panelText = panelText.slice(0, 800)
    record('面板渲染出内容', panelText.includes('远端工作台'), panelText.split('\n').slice(0, 3).join(' / '))
    record('面板里看得到实例', panelText.includes(instanceLabel), instanceLabel)
    fs.writeFileSync(path.join(outDir, 'panel-stopped.png'), (await wc.capturePage()).toPNG())
  }

  // 5. 点启动 → 等运行中
  if (panelUp && !skipStart) {
    const clicked = await js(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('.drd-toolbar button'))
        const target = buttons.find((node) => (node.textContent ?? '').trim() === '启动')
        if (target === undefined) return false
        target.click()
        return true
      })()
    `)
    record('点到了「启动」', clicked === true)
    const running = await waitFor(
      `(() => { const el = document.querySelector('.drd-root'); return el !== null && el.innerText.includes('运行中') })()`,
      150_000,
      '实例进入运行中',
    )
    if (running) {
      record('面板显示运行中', true, (await js('document.querySelector(".drd-toolbar").innerText')).replace(/\n/g, ' / '))
      // 等镜像容器把远端 UI 拉起来
      const staged = await waitFor(
        '!!document.querySelector(".drd-stage iframe, .drd-stage webview")',
        30_000,
        '镜像容器出现',
      )
      if (staged) {
        const carrier = await js(
          'document.querySelector(".drd-stage webview") !== null ? "webview" : (document.querySelector(".drd-stage iframe") !== null ? "iframe" : "none")',
        )
        record('镜像容器类型', true, carrier)
        await wait(8000)
        const note = await js('(document.querySelector(".drd-root .drd-meta") ?? {}).innerText ?? ""')
        record('容器状态说明', true, String(note).slice(0, 120))
      }
      fs.writeFileSync(path.join(outDir, 'panel-running.png'), (await wc.capturePage()).toPNG())
    }
  }

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ ...results, consoleErrors }, null, 2))
  record('控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
  win.destroy()
  app.exit(0)
}

main().catch((error) => {
  console.error('UI 验证崩溃：', error)
  try {
    fs.writeFileSync(path.join(outDir ?? '.', 'results.json'), JSON.stringify({ fatal: String(error) }, null, 2))
  } catch {
    /* 忽略 */
  }
  app.exit(1)
})

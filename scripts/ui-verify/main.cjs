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
const expectStage = process.env.UI_EXPECT_STAGE ?? 'iframe'
const expectNote = process.env.UI_EXPECT_NOTE ?? ''
const expectMirrorFrame = process.env.UI_EXPECT_MIRROR_FRAME ?? '1'
/**
 * 在壳子启动完成后注入一个最小桌面桥（`window.dshDesktop.browser`）。
 *
 * 为什么是"启动后注入"而不是用 preload：上一轮用 preload 时，壳子一启动就看到了 dshDesktop，
 * 于是走进 desktop 分支的引导页（欢迎/开始设置），根本到不了我们的面板。注入发生在页面就绪之后，
 * 启动分支不受影响，而面板挂载镜像时桥已经在了——这正好只压我们客户端那一半。
 */
const injectBridge = process.env.UI_INJECT_BRIDGE === '1'

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
    // 镜像端点用 302 发票据 cookie，Electron 会把被顶掉的导航记成 ERR_ABORTED——
    // 这是正常流程的噪声，客户端那边也已经显式忽略 -3。GUEST_VIEW_MANAGER_CALL 则是
    // 模拟壳子里 guest 自己的加载报错（webview-client 那一档已把 guest 内容列为观察项）。
    if (text.includes('ERR_ABORTED') || text.includes('GUEST_VIEW_MANAGER_CALL')) return
    if (level >= 2) consoleErrors.push(text.slice(0, 300))
  })
  wc.on('render-process-gone', (_event, details) => record('渲染进程存活', false, JSON.stringify(details)))

  const js = (code) => wc.executeJavaScript(code, true)
  // webview 载体：宿主侧的 guest 只有主进程看得到，这里记下来供断言用。
  let guestRef
  wc.on('did-attach-webview', (_event, guest) => {
    guestRef = guest
  })
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

  // 2b. 右栏是**会话作用域**的：没有挂载会话时 openTab 会抛 "no session surface is mounted"。
  //     要验 rightbar 载体就得先开一个会话（内容为空也没关系，会话本身只是载体）。
  if (process.env.UI_CREATE_SESSION === '1') {
    const created = await js(`
      (() => {
        const nodes = Array.from(document.querySelectorAll('button,[role="button"],a'))
        // 优先 aria-label（侧栏那颗按钮的可读名就是「新建会话」，文本里还带着快捷键）。
        const target =
          nodes.find((node) => (node.getAttribute('aria-label') ?? '') === '新建会话') ??
          nodes.find((node) => (node.textContent ?? '').trim().startsWith('新会话'))
        if (target === undefined) return false
        target.click()
        return true
      })()
    `)
    record('点到了「新会话」', created === true)
    const mounted = await waitFor(
      '!!document.querySelector("textarea, [contenteditable=true], .drd-root")',
      30_000,
      '会话工作面挂载',
    )
    if (!mounted) record('会话工作面挂载', false, '没等到可编辑区')
    await wait(1500)
  }

  // 3. 我们的侧栏入口（先把候选 dump 出来，找不到时也能看清结构）
  if (injectBridge) {
    const injected = await js(`
      (() => {
        window.dshDesktop = {
          protocolVersion: 1,
          browser: {
            acquire: async () => ({ lease: 'harness-' + Math.random().toString(36).slice(2), partition: 'harness-' + Math.random().toString(36).slice(2) }),
            release: async () => {},
          },
        }
        return typeof window.dshDesktop?.browser?.acquire === 'function'
      })()
    `)
    record('注入最小桌面桥', injected === true)
  }
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

  // 安静轮询：只等，不记失败（实验性载体用）
  const pollQuiet = async (code, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await js(code)) return true
      } catch {
        /* 页面还在导航 */
      }
      await wait(400)
    }
    return false
  }

  // 4. 面板（rightbar 载体下面板会立刻让位，所以判据放宽成"面板或镜像已出现"）
  const panelUp =
    expectStage === 'loose' || expectStage === 'gone'
      ? await pollQuiet(
          '!!document.querySelector(".drd-root") || !!document.querySelector(\'iframe[src*="127.0.0.1:196"]\')',
          25_000,
        )
      : await waitFor('!!document.querySelector(".drd-root")', 20_000, '面板出现')
  if (panelUp && expectStage !== 'gone' && expectStage !== 'loose') {
    const panelText = await js('document.querySelector(".drd-root").innerText')
    results.dom.panelText = panelText.slice(0, 800)
    record('面板渲染出内容', panelText.includes('远端工作台'), panelText.split('\n').slice(0, 3).join(' / '))
    record('面板里看得到实例', panelText.includes(instanceLabel), instanceLabel)
    fs.writeFileSync(path.join(outDir, 'panel-stopped.png'), (await wc.capturePage()).toPNG())
  }

  // 4b. 一键诊断：用户不用描述现象，点一下就能把状态贴出来
  if (panelUp && expectStage !== 'gone' && expectStage !== 'loose') {
    const clicked = await js(`
      (() => {
        const button = Array.from(document.querySelectorAll('.drd-bar button'))
          .find((node) => (node.textContent ?? '').trim() === '复制诊断')
        if (button === undefined) return false
        button.click()
        return true
      })()
    `)
    record('点得到「复制诊断」', clicked === true)
    const report = await waitFor('!!document.querySelector(".drd-root textarea")', 10_000, '诊断文本出现')
    if (report) {
      const text = await js('document.querySelector(".drd-root textarea").value')
      record('诊断文本含标题', String(text).includes('dsh-remote-desks 诊断'), String(text).slice(0, 40))
      record('诊断文本含实例与状态', String(text).includes('本机预演实例') || String(text).includes('ui-local'), '')
      record('诊断文本含容器说明', String(text).includes('容器说明'), String(text).split('\n').find((line) => line.includes('容器说明')) ?? '')
      record('诊断文本含日志尾部', String(text).includes('日志尾部'), '')
      fs.writeFileSync(path.join(outDir, 'diagnostics.txt'), String(text))
      // 关掉它再往下走：诊断面板的文字会混进后面那些 .drd-meta 的断言里。
      await js(`
        (() => {
          const button = Array.from(document.querySelectorAll('.drd-root button'))
            .find((node) => (node.textContent ?? '').trim() === '关闭')
          if (button !== undefined) button.click()
          return true
        })()
      `)
      await wait(500)
    }
  }

  // 5. 点启动 → 等运行中（rightbar 模式已由驱动脚本经 HTTP 预启动，面板也会让位）
  if (panelUp && expectStage !== 'gone' && expectStage !== 'loose' && !skipStart) {
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
      const runningText = (await js('document.querySelector(".drd-toolbar").innerText')).replace(/\n/g, ' / ')
      record('面板显示运行中', true, runningText)
      record('工具栏含「更新」', runningText.includes('更新'))
      const updateDisabled = await js(`
        (() => {
          const button = Array.from(document.querySelectorAll('.drd-toolbar button'))
            .find((node) => (node.textContent ?? '').trim() === '更新')
          return button === undefined ? 'missing' : String(button.disabled)
        })()
      `)
      record('运行中「更新」被禁用', updateDisabled === 'true', String(updateDisabled))
      // 等镜像容器就位：内嵌载体看 .drd-stage，右栏载体则看"面板已让位"。
      const staged = await waitFor(
        expectStage === 'gone'
          ? 'document.querySelector(".drd-root") === null'
          : '!!document.querySelector(".drd-stage iframe, .drd-stage webview, .drd-stage .drd-placeholder")',
        30_000,
        expectStage === 'gone' ? '面板让位' : '镜像容器出现',
      )
      if (staged) {
        const carrier = await js(
          'document.querySelector(".drd-stage webview") !== null ? "webview" : (document.querySelector(".drd-stage iframe") !== null ? "iframe" : "none")',
        )
        if (expectStage === 'loose') {
          // 实验性载体：只记录观察到的状态，不判成败。
          console.log(`  ·（loose）观察到的状态：${carrier}｜面板${(await js('document.querySelector(".drd-root") === null')) ? '已让位' : '仍在'}`)
        } else if (expectStage === 'webview') {
          record('容器类型是 webview', carrier === 'webview', `实际 ${String(carrier)}`)
          // 先把"还在 webview 状态"时的说明文字断言掉，再往下点兜底按钮（点了就变 iframe 了）。
          const noteNow = await js('Array.from(document.querySelectorAll(".drd-meta")).map((n) => n.innerText).join(" | ")')
          record(
            `容器说明含「${expectNote}」`,
            String(noteNow).includes(expectNote),
            String(noteNow).replace(/\n/g, ' ').slice(0, 140),
          )
          // 关键证据：guest 真的挂上了、导航到了镜像地址，而且它自己那份 DOM 里是远端 UI。
          await wait(8_000)
          if (guestRef === undefined) {
            record('主进程侧看到 guest', false, 'did-attach-webview 没触发')
          } else {
            record('主进程侧看到 guest', true)
            const guestUrl = guestRef.getURL()
            record('guest 已导航到镜像端点', /^http:\/\/127\.0\.0\.1:196\d\d\//.test(guestUrl), guestUrl.slice(0, 80))
            // guest 里的远端 UI 还在加载时会话可能一直不 settle，所以探测必须有上限——
            // 验证脚本自己挂住比失败更糟。
            const withTimeout = (promise, ms) =>
              Promise.race([promise, new Promise((done) => setTimeout(() => done('<超时>'), ms))])
            const guestDom = await withTimeout(
              guestRef.executeJavaScript('document.documentElement.outerHTML.slice(0, 6000)').catch((error) => `<出错 ${String(error)}>`),
              15_000,
            )
            // 这一条**只观察不判定**：这个壳子没有真桌面应用那套会话/分区准备，
            // guest 里能不能渲染出远端 UI 取决于环境，不能算在我们客户端头上。
            // 契约性的三条在上面（挂了 webview、guest 挂上了、导航到了镜像端点）。
            console.log(
              `  ·（观察）guest 里取到 ${String(guestDom).length} 字符` +
                `${String(guestDom).includes('__DSH_BOOT__') ? '，含远端 UI 的 __DSH_BOOT__' : '，没有远端 UI 痕迹'}`,
            )
            // 顺手验一下"挂上了却是空的"这条兜底：提示要出现，一键换载体要能用。
            await wait(4_000)
            const notes = await js('Array.from(document.querySelectorAll(".drd-meta")).map((n) => n.innerText).join(" | ")')
            record('空 guest 被识别并给出提示', String(notes).includes('空的'), String(notes).replace(/\n/g, ' ').slice(0, 120))
            const switched = await js(`
              (() => {
                const button = Array.from(document.querySelectorAll('.drd-stage button'))
                  .find((node) => (node.textContent ?? '').trim() === '改用内嵌框架')
                if (button === undefined) return false
                button.click()
                return true
              })()
            `)
            record('点得到「改用内嵌框架」', switched === true)
            if (switched) {
              await wait(3_000)
              const after = await js(
                'document.querySelector(".drd-stage iframe") !== null ? "iframe" : (document.querySelector(".drd-stage webview") !== null ? "webview" : "none")',
              )
              record('已退到内嵌框架', after === 'iframe', String(after))
            }
          }
        } else {
          const actual =
            expectStage === 'gone'
              ? (await js('document.querySelector(".drd-root") === null'))
                ? 'gone'
                : 'still-mounted'
              : carrier
          record(`容器类型符合预期（${expectStage}）`, actual === expectStage, `实际 ${String(actual)}`)
        }

        await wait(2500)
        // webview 档在分支里已经断言过说明文字了（那时还没点兜底按钮，状态才是对的）。
        if (expectNote !== '' && expectStage !== 'webview') {
          const notes = await js(
            'Array.from(document.querySelectorAll(".drd-root .drd-meta, .drd-stage .drd-placeholder")).map((n) => n.innerText).join(" | ")',
          )
          record(
            `容器说明含「${expectNote}」`,
            String(notes).includes(expectNote),
            String(notes).replace(/\n/g, ' ').slice(0, 160),
          )
        }

        // 指向镜像端口的 iframe 是否存在（内嵌载体在面板里，右栏载体在官方标签里）
        await wait(4000)
        const mirrorFrames = await js(`
          Array.from(document.querySelectorAll('iframe'))
            .map((node) => node.getAttribute('src') ?? '')
            .filter((src) => /^http:\\/\\/127\\.0\\.0\\.1:196\\d\\d\\//.test(src))
        `)
        const hasMirrorFrame = Array.isArray(mirrorFrames) && mirrorFrames.length > 0
        if (expectMirrorFrame === 'any') {
          console.log(`  ·（loose）文档里指向镜像端口的 iframe：${String((mirrorFrames ?? []).length)} 个`)
        } else {
          record(
            `镜像 iframe 存在性符合预期（期望 ${expectMirrorFrame}）`,
            hasMirrorFrame === (expectMirrorFrame === '1'),
            `实际 ${String(hasMirrorFrame)}（${String((mirrorFrames ?? []).length)} 个）`,
          )
        }
      }
      fs.writeFileSync(path.join(outDir, 'panel-running.png'), (await wc.capturePage()).toPNG())
    }
  }

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ ...results, consoleErrors }, null, 2))
  record('控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
  if (expectStage === 'gone') {
    // 右栏载体的最终判据：面板已让位，且文档里出现了指向镜像端口的 iframe。
    await wait(6000)
    const gone = await js('document.querySelector(".drd-root") === null')
    const frames = await js(`
      Array.from(document.querySelectorAll('iframe'))
        .map((node) => node.getAttribute('src') ?? '')
        .filter((src) => /^http:\\/\\/127\\.0\\.0\\.1:196\\d\\d\\//.test(src))
    `)
    record('面板已让位给右栏', gone === true)
    record('右栏里出现镜像 iframe', Array.isArray(frames) && frames.length > 0, `${String((frames ?? []).length)} 个`)
    fs.writeFileSync(path.join(outDir, 'panel-rightbar.png'), (await wc.capturePage()).toPNG())
  }
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

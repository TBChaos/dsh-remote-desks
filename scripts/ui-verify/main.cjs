// 真实浏览器验证（由 scripts/verify-ui.mjs 用 Electron 拉起）。
//
// 做法：用与桌面应用同一套 Chromium 打开真实的 DSH 界面（走 token 换 cookie 的正常路径），
// 找到我们的侧栏入口点开面板、点「启动」、等镜像区把远端 UI 渲染出来，然后截图。
//
// 环境变量：UI_URL（带 token 的地址）、UI_OUT（输出目录）、UI_INSTANCE（实例 label 关键字）
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
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
    // 保留尾巴：Chromium 把 `(net::ERR_xxx)` 放在消息最后，截前 300 字正好把它切掉。
    if (level >= 2) consoleErrors.push(text.length > 400 ? `${text.slice(0, 140)} … ${text.slice(-220)}` : text)
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
  // 形态选择记在本地（用户点过就以他为准），验证必须从干净状态开始，否则上一轮留下的
  // "管理界面"会带到这一轮，默认形态那几条断言就成了看运气。
  await js('(() => { try { localStorage.removeItem("dsh-remote-desks:layout-mode") } catch {} return true })()')
  await win.webContents.reload()
  await wait(2000)

  // 2. 等 shell 挂载
  await waitFor('!!document.querySelector("#root") && document.querySelector("#root").children.length > 0', 30_000, 'shell 挂载')
  await wait(2500)

  // 2c. 窗口角上的「本机 / WSL」切换下拉框。
  //     它挂在官方的 shell.overlay（帧级浮层）上，所以**还没打开我们的面板时就应该在**——
  //     这一条同时也是"注册进 shell.overlay 没有把官方条目顶掉"的实证。
  const switcher = await js(`
    (() => {
      const root = document.querySelector('.drd-switch')
      if (root === null) return { found: false }
      const select = root.querySelector('select')
      const rect = root.getBoundingClientRect()
      return {
        found: true,
        visible: rect.width > 0 && rect.height > 0,
        corner: root.getAttribute('data-corner'),
        top: Math.round(rect.top),
        gapRight: Math.round(window.innerWidth - rect.right),
        gapLeft: Math.round(rect.left),
        insideViewport: rect.top >= 0 && rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
        pointerEvents: getComputedStyle(root).pointerEvents,
        options: select === null ? [] : Array.from(select.options).map((option) => option.textContent.trim()),
        value: select === null ? '' : select.value,
      }
    })()
  `)
  results.dom.switcher = switcher
  record('窗口角上出现切换下拉框', switcher.found === true && switcher.visible === true, JSON.stringify(switcher).slice(0, 200))
  record(
    '切换器贴上边中间（不再压住右上角的图标）',
    switcher.insideViewport === true && switcher.corner === 'top-center',
    `corner=${String(switcher.corner)} top=${String(switcher.top)} gapRight=${String(switcher.gapRight)} gapLeft=${String(switcher.gapLeft)}`,
  )
  record('切换器自己接回指针事件（浮层是点击穿透的）', switcher.pointerEvents === 'auto', String(switcher.pointerEvents))
  record(
    '切换器列出了实例',
    Array.isArray(switcher.options) && switcher.options.some((text) => text.includes(instanceLabel)),
    (switcher.options ?? []).join(' / '),
  )

  // 2d. 模拟桌面版的窗口标题栏：官方 CSS 用 `html[data-windows-titlebar]` +
  //     `--dsh-windows-titlebar-height` 给框架加顶部留白，并给出 --dsh-frame-top-clearance。
  //     我们的切换器应当据此**钻进标题栏那条带子**（那条带子中间是空的），而不是压在会话表头上。
  const TITLEBAR = 44
  await js(`
    (() => {
      document.documentElement.setAttribute('data-windows-titlebar', '')
      document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '${String(TITLEBAR)}px')
      return true
    })()
  `)
  await wait(1500)
  // 等摆位真的换成标题栏模式：它既可能在属性变化时立刻重算，也可能等下一拍。
  await waitFor(`document.querySelector('.drd-switch')?.getAttribute('data-band') === 'chrome'`, 8000, '切换器进入标题栏带子')
  const inChrome = await js(`
    (() => {
      const root = document.querySelector('.drd-switch')
      if (root === null) return { found: false }
      const rect = root.getBoundingClientRect()
      const frame = document.querySelector('[class*="frame"]')
      const frameRect = frame === null ? null : frame.getBoundingClientRect()
      return {
        found: true,
        band: root.getAttribute('data-band'),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        gapLeft: Math.round(rect.left),
        gapRight: Math.round(window.innerWidth - rect.right),
        frameTop: frameRect === null ? null : Math.round(frameRect.top),
      }
    })()
  `)
  results.dom.switcherChrome = inChrome
  record(
    '有标题栏时切换器钻进标题栏那条带子',
    inChrome.band === 'chrome' && inChrome.bottom <= TITLEBAR,
    `band=${String(inChrome.band)} top=${String(inChrome.top)} bottom=${String(inChrome.bottom)} 标题栏高=${String(TITLEBAR)}`,
  )
  // 光"在带子里"还不够：得确认它真没压住会话表头（那正是用户截图里的问题）。
  const overHeader = await js(`
    (() => {
      const root = document.querySelector('.drd-switch')
      if (root === null) return { found: false }
      const pill = root.getBoundingClientRect()
      // 会话表头那一行：主区里最靠上的那块可读文本（标题 / 对话·轨迹）。
      const heads = Array.from(document.querySelectorAll('main, [class*="centerCol"], .drd-root'))
      const rects = heads.map((node) => node.getBoundingClientRect()).filter((rect) => rect.height > 0)
      const top = rects.length === 0 ? null : Math.round(Math.min(...rects.map((rect) => rect.top)))
      return { found: true, pillBottom: Math.round(pill.bottom), contentTop: top }
    })()
  `)
  record(
    '切换器没有压住主区内容（底部在内容上沿之上）',
    overHeader.found === true && (overHeader.contentTop === null || Number(overHeader.pillBottom) <= Number(overHeader.contentTop)),
    `切换器底 ${String(overHeader.pillBottom)}｜内容顶 ${String(overHeader.contentTop)}`,
  )
  record(
    '在带子里水平居中（左右等距）',
    Math.abs(Number(inChrome.gapLeft) - Number(inChrome.gapRight)) <= 2,
    `gapLeft=${String(inChrome.gapLeft)} gapRight=${String(inChrome.gapRight)}`,
  )

  // 2e. 窗口尺寸一变，位置跟着重算（不是"挂上去就不动了"）。
  const before = { w: win.getContentSize()[0], h: win.getContentSize()[1] }
  win.setContentSize(1180, before.h)
  await wait(1200)
  const afterResize = await js(`
    (() => {
      const root = document.querySelector('.drd-switch')
      if (root === null) return { found: false }
      const rect = root.getBoundingClientRect()
      return {
        found: true,
        base: root.getAttribute('data-band'),
        top: Math.round(rect.top),
        gapLeft: Math.round(rect.left),
        gapRight: Math.round(window.innerWidth - rect.right),
      }
    })()
  `)
  results.dom.switcherResize = afterResize
  record(
    '窗口变窄后仍然居中、仍在标题栏带子里',
    afterResize.found === true &&
      Math.abs(Number(afterResize.gapLeft) - Number(afterResize.gapRight)) <= 2 &&
      Number(afterResize.top) === Number(inChrome.top),
    `宽度 ${String(before.w)} → 1180｜gapLeft=${String(afterResize.gapLeft)} gapRight=${String(afterResize.gapRight)} top=${String(afterResize.top)}`,
  )
  win.setContentSize(before.w, before.h)
  await wait(800)

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

  // 4a. 默认形态：统一界面（选中的那台机器的 DSH 界面铺满主区）。
  //     这一屏还没启动实例，所以先断言"启动卡片"，再从卡片切到管理界面跑下面那套既有断言；
  //     镜像铺满 + 浮条在 4f 里（那时实例已经在跑）单独验。
  if (panelUp && expectStage !== 'gone' && expectStage !== 'loose') {
    const immersive = await js(`
      (() => {
        const root = document.querySelector('.drd-immersive')
        if (root === null) return { immersive: false }
        const buttons = Array.from(root.querySelectorAll('button')).map((node) => (node.textContent ?? '').trim())
        return {
          immersive: true,
          hasList: document.querySelector('.drd-list') !== null,
          hasToolbar: document.querySelector('.drd-toolbar') !== null,
          buttons,
        }
      })()
    `)
    record('默认形态是统一界面', immersive.immersive === true, JSON.stringify(immersive).slice(0, 200))
    if (immersive.immersive) {
      record('统一界面里没有管理用的列表与工具栏', immersive.hasList === false && immersive.hasToolbar === false)
      record(
        '未运行时给的是启动卡片（不是把人丢进管理界面）',
        Array.isArray(immersive.buttons) && immersive.buttons.includes('启动') && immersive.buttons.includes('管理界面'),
        (immersive.buttons ?? []).join(' / '),
      )
      const toManage = await js(`
        (() => {
          const button = Array.from(document.querySelectorAll('.drd-immersive button'))
            .find((node) => (node.textContent ?? '').trim() === '管理界面')
          if (button === undefined) return false
          button.click()
          return true
        })()
      `)
      record('卡片上的「管理界面」能切过去', toManage === true)
      await wait(800)
      record('切换后管理界面出来了', await js('!!document.querySelector(".drd-list") && !!document.querySelector(".drd-toolbar")'))
    }
  }

  if (panelUp && expectStage !== 'gone' && expectStage !== 'loose') {
    const panelText = await js('document.querySelector(".drd-root").innerText')
    results.dom.panelText = panelText.slice(0, 800)
    record('面板渲染出内容', panelText.includes('远端工作台'), panelText.split('\n').slice(0, 3).join(' / '))
    record('面板里看得到实例', panelText.includes(instanceLabel), instanceLabel)
    // 切换器与面板**共用同一个选中项**：面板默认显示第一个实例，切换器的值就该是它。
    const sharedValue = await js('document.querySelector(".drd-switch select")?.value ?? "<缺失>"')
    const activeInPanel = await js('document.querySelector(".drd-list .drd-item[data-active=\\"true\\"]") !== null')
    record('切换器的选中项与面板一致', activeInPanel === true && sharedValue !== '<缺失>' && sharedValue !== '', `value=${String(sharedValue)} 面板有选中=${String(activeInPanel)}`)
    // 浮层压住自己面板的按钮是不行的：切换器实测宽度 → --drd-switch-reserve → 面板表头让位。
    // 但默认已经改成贴上边中间了，那时**不该**再留白（面板表头保持原样）。
    const reserve = await js('getComputedStyle(document.documentElement).getPropertyValue("--drd-switch-reserve")')
    const barPadding = await js('getComputedStyle(document.querySelector(".drd-bar")).paddingRight')
    record(
      '贴上边中间时不占用面板表头的宽度',
      String(reserve).trim() === '' && Number.parseFloat(String(barPadding)) <= 20,
      `--drd-switch-reserve=${String(reserve).trim() || '（空）'} padding-right=${String(barPadding)}`,
    )
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

      // 4f. 回到统一界面：这一屏才是"和 WebUI 一样的界面和体验"——镜像铺满主区，只剩右下角一条浮条。
      const backToImmersive = await js(`
        (() => {
          const button = Array.from(document.querySelectorAll('.drd-bar button'))
            .find((node) => (node.textContent ?? '').trim() === '统一界面')
          if (button === undefined) return false
          button.click()
          return true
        })()
      `)
      record('管理界面上的「统一界面」能切回去', backToImmersive === true)
      if (backToImmersive) {
        await wait(6000)
        const filled = await js(`
          (() => {
            const root = document.querySelector('.drd-immersive')
            if (root === null) return { immersive: false }
            const frame = root.querySelector('iframe, webview')
            const bar = root.querySelector('.drd-float')
            const rootRect = root.getBoundingClientRect()
            const frameRect = frame === null ? null : frame.getBoundingClientRect()
            return {
              immersive: true,
              hasFrame: frame !== null,
              root: { w: Math.round(rootRect.width), h: Math.round(rootRect.height) },
              frame: frameRect === null ? null : { w: Math.round(frameRect.width), h: Math.round(frameRect.height) },
              floatBar: bar !== null,
              list: document.querySelector('.drd-list') !== null,
            }
          })()
        `)
        const fills =
          filled.frame !== null &&
          filled.frame.w >= filled.root.w - 2 &&
          filled.frame.h >= filled.root.h - 2
        record(
          '统一界面下镜像铺满主区',
          filled.immersive === true && fills,
          `容器 ${JSON.stringify(filled.root)}｜镜像 ${JSON.stringify(filled.frame)}`,
        )
        record('统一界面下浮条还在', filled.floatBar === true && filled.list === false)

        // 4g.「全窗口」= 收掉官方侧栏，让这台机器的界面拿到整扇窗（官方框架上会挂 data-sidebar-collapsed）。
        const clickFloat = (label) =>
          js(`
            (() => {
              const button = Array.from(document.querySelectorAll('.drd-float button'))
                .find((node) => (node.textContent ?? '').trim() === ${JSON.stringify(label)})
              if (button === undefined) return false
              button.click()
              return true
            })()
          `)
        const collapseClicked = await clickFloat('全窗口')
        await wait(1200)
        const collapsedNow = await js('document.querySelector("[data-sidebar-collapsed]") !== null')
        record('「全窗口」把官方侧栏收成了窄条', collapseClicked === true && collapsedNow === true, `点击=${String(collapseClicked)} 收起=${String(collapsedNow)}`)
        if (collapsedNow === true) fs.writeFileSync(path.join(outDir, 'panel-immersive-fullwindow.png'), (await wc.capturePage()).toPNG())
        await clickFloat('全窗口')
        await wait(1200)
        const expandedAgain = await js('document.querySelector("[data-sidebar-collapsed]") === null')
        record('再点一次能展开回来', expandedAgain === true)
        fs.writeFileSync(path.join(outDir, 'panel-immersive.png'), (await wc.capturePage()).toPNG())
      }
    }
  }

  // 4h. 第三方 iframe：桌面版里顶层文档是 dsh-app://app，所以镜像**是跨站 iframe**——
  //     SameSite=Lax 的票据 cookie 在那里不会被带上，表现就是镜像里显示"需要票据"。
  //     这里用 http://localhost:<port> 当顶层（与 127.0.0.1 不同站）复现同一个条件。
  //     必须是最后一步：它会把另一个窗口导航走（主窗口不动，所以前面那些断言不受影响）。
  if (expectStage !== 'gone' && expectStage !== 'loose') {
    const entryUrl = await js(`
      (() => {
        const frame = document.querySelector('iframe[src*="127.0.0.1:196"]')
        return frame === null ? '' : frame.getAttribute('src')
      })()
    `)
    if (typeof entryUrl !== 'string' || entryUrl === '') {
      record('跨站 iframe 回归（拿到镜像入口）', false, '页面里找不到带票据的镜像 iframe')
    } else {
      const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>cross-site</title>
<style>html,body{margin:0;height:100%;background:#111}iframe{width:100%;height:100%;border:0}</style></head>
<body><iframe id="m" src="${entryUrl}"></iframe></body></html>`
      const cookies = []
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(page)
      })
      await new Promise((done) => server.listen(0, done))
      const crossPort = server.address().port

      const mirrorOrigin = new URL(entryUrl).origin
      const win2 = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { contextIsolation: true } })
      // 匹配模式里的端口不能带通配符，所以这里用从入口地址解析出来的精确 origin。
      win2.webContents.session.webRequest.onHeadersReceived(
        { urls: [`${mirrorOrigin}/*`] },
        (details, callback) => {
          const header = details.responseHeaders?.['Set-Cookie'] ?? details.responseHeaders?.['set-cookie']
          if (header !== undefined) cookies.push(...[].concat(header).map((value) => String(value).slice(0, 90)))
          callback({})
        },
      )

      /** 在一个跨站顶层里探镜像帧：能取回远端 UI 才算过。 */
      const probeCrossSite = async (topUrl, label) => {
        await win2.loadURL(topUrl)
        await wait(9000)
        const frames = win2.webContents.mainFrame.frames
        const mirrorFrame = frames.find((frame) => /^http:\/\/127\.0\.0\.1:196\d\d\//.test(frame.url))
        if (mirrorFrame === undefined) {
          record(`${label}：镜像帧存在`, false, `frames=${frames.map((frame) => frame.url).join(' , ') || '空'}`)
          return
        }
        record(`${label}：镜像帧存在`, true, mirrorFrame.url)
        const text = await mirrorFrame
          .executeJavaScript('document.body ? document.body.innerText.slice(0, 160) : "<没有 body>"')
          .catch((error) => `<出错 ${String(error)}>`)
        const rendered = await mirrorFrame
          .executeJavaScript('document.documentElement.outerHTML.includes("__DSH_BOOT__")')
          .catch(() => false)
        record(
          `${label}：不再显示「需要票据」`,
          typeof text === 'string' && !text.includes('需要票据'),
          String(text).replace(/\s+/g, ' ').slice(0, 110),
        )
        record(`${label}：渲染出远端 UI`, rendered === true)
        fs.writeFileSync(path.join(outDir, `cross-site-${label}.png`), (await win2.webContents.capturePage()).toPNG())
      }

      try {
        const pageFile = path.join(outDir, 'cross-site.html')
        fs.writeFileSync(pageFile, page)
        // 两个顶层各来一遍：localhost 与 127.0.0.1 不同站；file:// 更接近桌面版那种"非 http 顶层"。
        await probeCrossSite(`http://localhost:${String(crossPort)}/cross.html`, 'localhost')
        const redirectCookie = cookies.join(' | ')
        results.dom.crossSiteCookies = cookies
        record(
          '跨站 iframe 下发的票据 cookie 是 SameSite=None; Secure',
          /SameSite=None/i.test(redirectCookie) && /Secure/i.test(redirectCookie),
          redirectCookie.slice(0, 160) || '（没抓到 Set-Cookie）',
        )
        await probeCrossSite(`file:///${pageFile.replace(/\\/g, '/')}`, 'file')
      } finally {
        win2.destroy()
        await new Promise((done) => server.close(done))
      }
    }
  }

  // 4i. 切换实例：用窗口角上的下拉框切到第二台（它会自己启动），验证——
  //     ① 切换器真的能带起一台没在跑的实例；② 切过去之后**前一台不卸载**（保活），
  //     所以切回来是瞬间的，而不是重新渲染一遍。
  if (expectStage !== 'gone' && expectStage !== 'loose') {
    const switched = await js(`
      (() => {
        const select = document.querySelector('.drd-switch select')
        if (select === null) return false
        const option = Array.from(select.options).find((node) => (node.textContent ?? '').includes('第二台'))
        if (option === undefined) return false
        select.value = option.value
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()
    `)
    record('切换器里能找到第二台', switched === true)
    if (switched) {
      const running2 = await waitFor(
        `(() => { const el = document.querySelector('.drd-float'); return el !== null && el.innerText.includes('第二台') && el.innerText.includes('运行中') })()`,
        150_000,
        '第二台起来并接手前台',
      )
      record('切换后第二台自己起起来并接手前台', running2 === true)
      // 等第二台**真的渲染出远端 UI** 再切走：切走会把还在下载的资源掐掉，那不是产品问题，
      // 别让验证脚本自己制造噪声（这一条同时也证明了新起的那台确实渲染得出来）。
      const secondUrl = await js(`
        (() => {
          const cell = document.querySelector('.drd-keep[data-active="true"]')
          const frame = cell === null ? null : cell.querySelector('iframe')
          return frame === null ? '' : (frame.getAttribute('src') ?? '')
        })()
      `)
      const secondOrigin =
        typeof secondUrl === 'string' && secondUrl !== '' ? new URL(secondUrl).origin : ''
      record('第二台的镜像帧挂上了', secondOrigin !== '', String(secondUrl).slice(0, 60))
      if (secondOrigin !== '') {
        const deadline = Date.now() + 120_000
        let done = false
        let why = '（没找到帧）'
        while (Date.now() < deadline && !done) {
          const frame = wc.mainFrame.frames.find((item) => item.url.startsWith(secondOrigin))
          if (frame !== undefined) {
            try {
              // 用 textContent 而不是 innerText：innerText 对隐藏子树返回空串，
              // 而"渲染出来了"这件事跟可见性是两回事。
              done = await frame.executeJavaScript(
                'document.documentElement.outerHTML.includes("__DSH_BOOT__") && (document.body?.textContent ?? "").trim().length > 0',
              )
              if (!done) {
                why = await frame.executeJavaScript(
                  'JSON.stringify({ len: (document.body?.textContent ?? "").trim().length, boot: document.documentElement.outerHTML.includes("__DSH_BOOT__"), head: document.documentElement.outerHTML.slice(0, 160) })',
                )
              }
            } catch (error) {
              why = `executeJavaScript 抛错：${String(error).slice(0, 120)}`
            }
          }
          if (!done) await wait(1500)
        }
        record('第二台渲染出远端 UI', done === true, done === true ? '' : String(why).slice(0, 200))
      }
      const kept = await js(`
        (() => {
          const cells = Array.from(document.querySelectorAll('.drd-keep'))
          return {
            total: cells.length,
            visible: cells.filter((cell) => cell.getAttribute('data-active') === 'true').length,
            hidden: cells.filter((cell) => cell.hasAttribute('hidden')).length,
            frames: cells.map((cell) => cell.querySelector('iframe, webview') !== null),
          }
        })()
      `)
      record('切过去之后两台都还挂着（保活）', kept.total >= 2 && kept.hidden >= 1 && kept.visible === 1, JSON.stringify(kept))
      fs.writeFileSync(path.join(outDir, 'panel-two-instances.png'), (await wc.capturePage()).toPNG())

      // 切回第一台：应该是**同一帧**重新显示出来（保活生效），而不是新挂一个。
      const back = await js(`
        (() => {
          const select = document.querySelector('.drd-switch select')
          if (select === null) return false
          const option = Array.from(select.options).find((node) => (node.textContent ?? '').includes('本机预演'))
          if (option === undefined) return false
          select.value = option.value
          select.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        })()
      `)
      record('能切回第一台', back === true)
      await wait(1500)
      const quick = await js(`
        (() => {
          const cells = Array.from(document.querySelectorAll('.drd-keep'))
          const active = cells.find((cell) => cell.getAttribute('data-active') === 'true')
          const frame = active === undefined ? null : active.querySelector('iframe, webview')
          if (frame === null) return { ok: false, src: '' }
          return { ok: true, src: frame.getAttribute('src') ?? '' }
        })()
      `)
      record(
        '切回来还是那一帧（保活生效，不重新渲染）',
        quick.ok === true && /127\.0\.0\.1:196/.test(quick.src),
        JSON.stringify(quick),
      )
      fs.writeFileSync(path.join(outDir, 'panel-switch-back.png'), (await wc.capturePage()).toPNG())
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

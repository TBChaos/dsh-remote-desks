# dsh-remote-desks · 远端工作台

把**本机 / WSL / SSH 远端**上另一套 DSH 的 WebUI **镜像进桌面版 DSH**，并在同一套界面里
启动、停止这些实例。

镜像出来的界面就是 DSH 自己的前端（随远端版本走），桌面窗口的外壳、主题、侧栏与快捷键
全部复用当前应用，不另造一套 UI。

> **状态：M0 完成并已验证。** 面板、控制接口、构建链路与三道验证齐备；实例管理在 M1 接入。
> 里程碑与已核实的技术约束见 [里程碑与范围](#里程碑与范围)。

## 它解决什么

同一台机器上经常不止一套 DSH：Windows 本机一套、WSL 里一套、服务器上还有几套。
它们的 WebUI 各自独立，切换要开浏览器、记端口、贴带 token 的地址。

这个插件把那些实例的界面直接搬进桌面应用：左侧列出实例，点一下就在主面板里看到它的
完整界面，并且能在这里启动、停止它们。

## 设计要点（都由发行版源码核实过）

| 约束 | 结论 |
|---|---|
| 桌面窗口允许 `<webview>`，但无 lease 的挂载会被主进程拦掉 | 用官方 `window.dshDesktop.browser.acquire()` 拿 lease，再挂 `<webview>` |
| guest 禁止访问与宿主同端口的回环地址 | **每个实例一个独立端口的镜像端点**，不挂在本地 DSH 的 19387 上 |
| 桌面渲染层 origin 是 `dsh-app://app`，其非静态路径会转发给本地 host | 插件注册的 host 路由在桌面版与纯 Web 版里都能用相对路径 `fetch` 到 |
| 插件路由默认**不鉴权** | 控制接口自带闸门：优先复用官方 `connection.requestRejection`，否则用等价的回环校验 |
| 远端 UI 全部使用文档相对路径（`<base href="./">`、WS 取 `document.baseURI`） | 代理可以原样转发，不需要改写远端 HTML |
| `desktop` profile 由桌面应用独占，且 19387 是硬编码端口 | 自己拉起的实例一律用独立 profile + `--port 0` |

## 安装

```bash
pnpm install
pnpm verify          # tsc + 客户端 bundle + 冒烟测试
dsh plugin --profile desktop add <本目录路径>
```

`cordis.patch.yml` 会被自动并入 profile（`dsh.bundle.patch`）。装好后重启桌面应用，
侧栏会出现「远端工作台」入口；设置页里也有一节同名页面，可以查看宿主能力矩阵。

## 配置

```yaml
- id: remote-desks
  name: dsh-remote-desks
  config:
    instances:
      - id: wsl-ubuntu
        kind: wsl
        distro: Ubuntu-24.04
        user: you
        cwd: /home/you/project
      - id: local-dev
        kind: local
        profile: mirror-local-dev
        cwd: D:\work\demo
      - id: build-server
        kind: ssh
        host: 10.0.0.8
        username: deploy
        auth:
          method: privateKey
          privateKeyPath: C:\Users\you\.ssh\id_ed25519
```

密码与口令**不写进配置**，只写凭据名（`passwordCredential` / `passphraseCredential`），
值放在 DSH 凭据库里。

## 控制接口

M0 只提供两个只读端点，供面板与排障使用：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/remote-desks/api/state` | 能力矩阵 + 配置摘要 |
| `GET` | `/remote-desks/api/ping` | 存活探测 |

**两道闸门叠加**，缺一不可：

1. 官方 `connection.requestRejection`（认识 `trustedHosts` 与 `Sec-Fetch-Site`，并校验会话 cookie）；
2. 本插件自己的回环校验（Host 必须是 `127.0.0.1` / `localhost` / `[::1]`，带 Origin 时其 Host 必须与请求 Host 一致）。

控制接口能启停进程，所以第二层不是多余的。判定的结果会写在 `/api/state` 的 `control.gate` 里。
因此：**裸 curl（没有会话 cookie）拿到 401，伪造非回环 Host 拿到 403**，桌面版与纯 Web 版
（都带 host 自己发的会话 cookie）才拿得到 200。

## 开发

```bash
pnpm install
pnpm build        # tsc -> lib/，再把客户端打成一枚 __ModuleLoader__ bundle
pnpm typecheck    # host 与 client 两套 tsconfig
pnpm smoke        # 载入真实产物跑行为断言（53 项）
pnpm verify       # build + smoke
pnpm verify:live  # 起一个真实 DSH 实例做端到端验证（见下）
```

### 三道验证

**第一道 · `pnpm smoke`（53 项）** 跑真实产物，不复述实现：

1. 导入 `lib/index.js`，检查插件契约（`name` / `inject` / `Config` / `apply`），
   用真实 `Config` 校验空配置补全、默认值、非法 `kind` 与缺 `id` 的拒绝；
2. 用伪造 `ctx` 调 `apply()`，再拿**真实 handler** 发请求：回环 200、IPv6 回环 200、
   局域网 Host 403、跨站 Origin 403、未知路径 404、非 GET 404、缺 Host 403；
   再用带 `connection.requestRejection` 的 ctx 验证**两道闸门叠加**（官方拒绝 401、
   官方放行但非回环仍 403）；
3. 在 `node:vm` 里加载 `lib/client.js`，喂假的 `window.__ModuleLoader__` 与 `require`
   （非基线模块直接报错），取出工厂并调 `apply()`，断言它挂上了
   `sidebar.panellist` / `main` / `settings.section` 三处注册，且面板 id 与入口 id 一致。

**第二道 · `pnpm verify:live`（15 项）** 起一个真实 DSH web 实例（临时 profile，
`dsh-base` + `dsh-web-app` + 本插件），验证真实 Loader 树里的行为：

```bash
node scripts/verify-live.mjs \
  --pnpm "C:\Users\you\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" \
  --node "C:\Users\you\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
```

它会：等 `dsh web:` 就绪行 → 裸请求被拒（401）→ token 换 cookie → 带 cookie 拿到能力矩阵
（`gate` 显示为 `connection.requestRejection + loopback-guard`）→ 伪造非回环 Host 得 403 →
index 的 `window.__DSH_BOOT__` 里出现本插件的行 → 按该行 URL 取到 `__ModuleLoader__` 形态的
客户端 bundle。跑完自动清理 profile（`--keep-profile` 可保留）。

**第三道 · 装进桌面版**：`dsh-remote-desks` 已装入 desktop profile，`dsh.bundle.patch` 会把
`remote-desks` 行插进 Loader 树。桌面版是**启动型 profile**，加载新 bundle 行需要**重启一次
桌面应用**；重启后侧栏出现「远端工作台」入口。

## 布局

```
src/
  index.ts              host 入口：装配、控制路由、就绪日志
  config.ts             配置 schema 与类型
  capabilities.ts       宿主能力探测（服务、运行形态、DSH 发行版入口）
  control/routes.ts     控制接口 + 回环闸门
  client/index.tsx      客户端半边：面板 / 侧栏入口 / 设置页
scripts/
  build-client.mjs      客户端 bundle 打包（__ModuleLoader__ 外壳）
  smoke.mjs             载入期冒烟测试
  verify-live.mjs       活体验证：起真实实例跑端到端（M1 启动器的最小原型）
cordis.patch.yml        bundle patch（安装时并入 profile）
.recon/                 侦察产物（解包的 DSH 发行版源码 + 笔记），已 gitignore
```

## 里程碑与范围

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 骨架、能力探测、控制接口、面板占位 | **完成并验证** |
| M1 | 多实例并发：实例监管器、本机与 WSL 启动器、镜像代理、面板标签切换 | 待做 |
| M2 | SSH 实例（含跳板机，数据面走 `forwardOut`，不开远端端口） | 待做 |
| M3 | 打磨：日志面板、纯 Web 版适配、中文文案与文档 | 待做 |
| — | 更新（升级实例的 DSH 包） | 挂起，M1–M3 跑通后再评估 |

## 许可

MIT，见 [LICENSE](LICENSE)。

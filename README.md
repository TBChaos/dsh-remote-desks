# dsh-remote-desks · 远端工作台

把**本机 / WSL / SSH 远端**上另一套 DSH 的 WebUI **镜像进桌面版 DSH**，并在同一套界面里
启动、停止这些实例。

镜像出来的界面就是 DSH 自己的前端（随远端版本走），桌面窗口的外壳、主题、侧栏与快捷键
全部复用当前应用，不另造一套 UI。

> **状态：M0 / M1 / M2 / M3 代码完成，宿主侧全部已验证。** 本机、WSL、SSH 三种实例都能
> 并发启动、镜像、停止；面板、设置页、日志抽屉、容器降级链都已接好。
> **待你验收的是界面**：面板与 webview/iframe 容器的渲染需要有头环境，自动化验证覆盖不到
> （见 [已知边界](#已知边界未自动验证的部分)）。

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

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/remote-desks/api/state` | 能力矩阵 + 配置摘要 |
| `GET` | `/remote-desks/api/ping` | 存活探测 |
| `GET` | `/remote-desks/api/instances` | 全部实例的运行时快照 |
| `GET` | `/remote-desks/api/instances/:id` | 单个实例快照（含 `phase` / 镜像地址 / 退出码） |
| `GET` | `/remote-desks/api/instances/:id/logs?offset=N` | 增量拉日志（行号偏移，环形缓冲 600 行） |
| `GET` | `/remote-desks/api/instances/:id/check` | **预检**：不启动实例，只列出缺什么 |
| `POST` | `/remote-desks/api/instances/:id/start\|stop\|restart` | 生命周期操作 |

**预检**（面板工具栏上的「预检」按钮）回答的是"点了启动会不会失败"：

- 本机：运行时入口是否存在、启动方式（Electron Node 模式 / node）、工作目录、`DSH_HOME`、profile 状态
- WSL：发行版能否进入、里面有没有 node 与 dsh、启动命令
- SSH：端口是否可达、认证材料是否齐（私钥可读 / 凭据已配置 / agent 存在）、跳板逐跳可达

检查项都是廉价只读探测，不产生副作用；失败项会直接给出"缺什么"而不是一句报错。

**两道闸门叠加**，缺一不可：

1. 官方 `connection.requestRejection`（认识 `trustedHosts` 与 `Sec-Fetch-Site`，并校验会话 cookie）；
2. 本插件自己的回环校验（Host 必须是 `127.0.0.1` / `localhost` / `[::1]`，带 Origin 时其 Host 必须与请求 Host 一致）。

控制接口能启停进程，所以第二层不是多余的。判定的结果会写在 `/api/state` 的 `control.gate` 里。
因此：**裸 curl（没有会话 cookie）拿到 401，伪造非回环 Host 拿到 403**，桌面版与纯 Web 版
（都带 host 自己发的会话 cookie）才拿得到 200。

## 镜像端点

每个**运行中**的实例独占一个只监听回环的 HTTP 端口，把远端实例的 UI 原样搬到
`http://127.0.0.1:<port>/`，HTTP / WebSocket / SSE 都转发。为什么不做成本地 DSH 的一条子路径：

1. 桌面端 Electron guest 明确禁止访问与宿主同端口的回环地址（`isApplicationHost`），挂在 19387 上会被直接拦掉；
2. 同源会让远端实例的脚本能拿着你的 cookie 调本地 `/api`（confused deputy），独立端口天然做掉源隔离。

访问需要票据：首次打开 `?k=<ticket>` 换成 cookie，之后所有子请求与 WS 握手都靠它；
无票据或票据错误一律 403。转发时会把 `host` / `origin` 改写成远端自己的 authority、
注入启动时换好的远端会话 cookie，并剥掉 `content-security-policy` / `x-frame-options`
（否则嵌不进来）与逐跳头，同时把 `set-cookie` 归一成属于镜像 origin 的形态。

## WSL 的三条硬约束（都实测过）

写 WSL 启动命令时踩到的坑，已固化在默认命令里：

1. **必须单行**：多行命令在 Windows → WSL 这一跳会丢换行；
2. **不能有变量赋值**：`P=...`、`export P=...`、`declare P=...` 都会被 wsl.exe 当环境变量赋值吃掉
   （所以路径一律内联 `$HOME`）；
3. **不含双引号**：JSON 用 base64 传进去，把引号一起消掉。

另外两个环境事实：发行版里的 node 常常只配在 `~/.bashrc`（nvm），登录 shell 不加载，所以默认命令
会显式 source `~/.nvm/nvm.sh`；WSL 里绑 `127.0.0.1` 的端口能否被 Windows 直连取决于网络模式
（镜像网络可以，默认 NAT 不行），监管器会**先探测再决定**，不通就给出明确诊断而不是留一个连不上的镜像。

> 想用自己的启动方式？把 `launchCommand` 写进实例配置即可，但上面三条约束同样适用。

## SSH 实例

```yaml
- id: build-server
  kind: ssh
  host: 10.0.0.8
  port: 22
  username: deploy
  cwd: /srv/app
  auth:
    method: password                 # privateKey | password | agent
    passwordCredential: BUILD_SERVER_PASSWORD
  # 可选：固定主机密钥指纹（SHA256 base64）
  # hostKeyFingerprint: SHA256:xxxx
  # 可选：跳板链
  # jumpHosts:
  #   - { host: jump.example, port: 22, username: ops }
```

- **认证**：`privateKey` 读 `privateKeyPath`（口令走 `passphraseCredential`）、`password` 走
  `passwordCredential`、`agent` 用 `SSH_AUTH_SOCK`（Windows 退到 `\\.\pipe\openssh-ssh-agent`）。
- **凭据**：`*Credential` 字段是 DSH 凭据库里的**名字**。名字也可以直接是环境变量名——
  凭据服务本身就把进程环境当作一层来源，所以 CI/验证场景不必往凭据库里写东西。
- **主机密钥**：默认 TOFU——接受并在实例日志里打印 `SHA256:…` 指纹；把指纹写进
  `hostKeyFingerprint` 即变成硬校验，不匹配直接拒连。
- **数据面**：控制面与数据面**共用一条 SSH 连接**，每条上游请求就是一条 `direct-tcpip` 通道
  （`forwardOut`）。远端不需要暴露端口，也不用建本地端口转发；换 cookie 的那次请求同样走隧道。

### 本机怎么验证 SSH 腿

这台机器上既没有 Windows sshd、WSL 也没装 openssh-server，所以仓库自带一个**测试对端**
（`scripts/ssh-test-server.mjs`，用 ssh2 的 Server 实现，把 exec 与 direct-tcpip 都转给 WSL）：

```bash
node scripts/ssh-test-server.mjs --port 12222 --password dsh-test      # 手动起
node scripts/verify-live.mjs --ssh --pnpm <pnpm.mjs> --node <node.exe> # 验证脚本自己起
```

它只用于验证**我们这一侧**的连接、认证、通道与隧道代码，**不要当生产服务用**。

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

**第一道 · `pnpm smoke`（112 项）** 跑真实产物，不复述实现：

1. 导入 `lib/index.js`，检查插件契约（`name` / `inject` / `Config` / `apply`），
   用真实 `Config` 校验空配置补全、默认值、非法 `kind` 与缺 `id` 的拒绝；
2. 用伪造 `ctx` 调 `apply()`，再拿**真实 handler** 发请求：回环 200、IPv6 回环 200、
   局域网 Host 403、跨站 Origin 403、未知路径 404、非 GET 404、缺 Host 403；
   再用带 `connection.requestRejection` 的 ctx 验证**两道闸门叠加**（官方拒绝 401、
   官方放行但非回环仍 403）；
3. 在 `node:vm` 里加载 `lib/client.js`，喂假的 `window.__ModuleLoader__` 与 `require`
   （非基线模块直接报错），取出工厂并调 `apply()`，断言它挂上了
   `sidebar.panellist` / `main` / `settings.section` 三处注册，且面板 id 与入口 id 一致。

**第二道 · `pnpm verify:live`（三条腿：本机 / WSL / SSH）** 起一个真实 DSH web 宿主（临时 profile，
`dsh-base` + `dsh-web-app` + 本插件），在里面驱动插件真的拉起实例，并逐条验证：

```bash
node scripts/verify-live.mjs \
  --pnpm "C:\Users\you\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" \
  --node "C:\Users\you\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" \
  --wsl Ubuntu-24.04 --ssh
```

它会：等 `dsh web:` 就绪行 → 裸请求被拒（401）→ token 换 cookie → 能力矩阵 200
（`gate = connection.requestRejection + loopback-guard`）→ 伪造非回环 Host 得 403 →
index 的 `window.__DSH_BOOT__` 里出现本插件的行 → 取到 `__ModuleLoader__` 形态的客户端 bundle；
然后对**每一个**实例：启动 → 就绪 → 无票据 403 → 票据换 cookie 302 → **镜像 UI 200** →
镜像里的子资源 200 → 停止 → 端点收摊。跑完自动清理 profile（`--keep-profile` 可保留）。

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
| M1 | 多实例并发：实例监管器、本机与 WSL 启动器、镜像代理、面板标签切换 | **完成并验证**（本机 + WSL 两条腿） |
| M2 | SSH 实例（含跳板机，数据面走 `forwardOut`，不开远端端口） | **完成并验证**（测试对端，真实 SSH 协议） |
| M3 | 打磨：多实例并发验证、日志抽屉、纯 Web 版适配、文档 | **完成**（界面渲染待你验收） |
| — | 更新（升级实例的 DSH 包） | 挂起，按约定 M1–M3 跑通后再评估 |

## 已知边界（未自动验证的部分）

自动化能证明的都证明了；剩下这几条要么需要人眼，要么需要真实环境，写在这里免得误以为都覆盖了：

1. **面板与镜像容器的渲染**：webview / iframe 的实际显示需要有头浏览器或桌面窗口，验证脚本
   只能证明"客户端 bundle 被正确服务、`__ModuleLoader__` 形态正确、slot 注册齐全"。
   需要你重启桌面应用看一次。
2. **真实 sshd 的互操作**：SSH 腿用仓库自带的测试对端（ssh2 Server，真实 SSH 协议）验证，
   覆盖了连接、密码认证、exec、`direct-tcpip`、隧道换 cookie、镜像往返。**没覆盖**的是各家
   sshd 的特有行为：`keyboard-interactive`、`ProxyJump` 在服务端的配置差异、以及主机密钥
   指纹固定的实际拒连（代码里有，但没拿真实指纹试过）。
3. **纯 Web 版**：控制接口、鉴权闸门、客户端 bundle 都是在纯 web 宿主（`dsh-base` + `dsh-web-app`，
   无 Electron）里验证的，所以宿主侧等价；只有"iframe 容器长什么样"没看。
4. **长稳**：验证是秒级到分钟级的往返，没有做小时级稳定性与内存观测（日志环已有上限，600 行）。

## 许可

MIT，见 [LICENSE](LICENSE)。

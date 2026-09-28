import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { RemoteDeskInstance } from '../config.js'
import type { LaunchSpec, LocalRuntime } from './types.js'

/** 实例默认使用的 profile 名；桌面应用独占 `desktop`，任何情况下都不能用。 */
export function profileOf(instance: RemoteDeskInstance): string {
  const profile = instance.profile ?? `mirror-${instance.id}`
  if (profile === 'desktop') {
    throw new Error(`实例 ${instance.id} 不能使用 desktop profile —— 它由桌面应用独占`)
  }
  return profile
}

/**
 * 确保 profile 存在。
 *
 * profile 只是一份清单 + 一层补丁，bundle 由 DSH 发行版自己解析，所以这里**不需要包管理器**：
 * 写两个文件就够（桌面应用创建首个外部插件 profile 时也是这么做的）。
 */
export function ensureProfile(dshHome: string, profile: string): { dir: string; created: boolean } {
  const dir = join(dshHome, 'profiles', profile)
  const manifest = join(dir, 'package.json')
  if (existsSync(manifest)) return { dir, created: false }

  mkdirSync(dir, { recursive: true })
  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        name: `dsh-profile-${profile}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    `# 由 dsh-remote-desks 自动创建的镜像实例 profile（${profile}）。\n[]\n`,
    'utf8',
  )
  return { dir, created: true }
}

/** 本机实例：用 Electron 的 Node 模式跑 DSH 发行版自带的 CLI。 */
export function localSpec(
  instance: RemoteDeskInstance,
  runtime: LocalRuntime,
  dshHome: string,
): LaunchSpec {
  const entry = instance.entry ?? runtime.entry
  const execPath = instance.nodePath ?? runtime.execPath
  const profile = profileOf(instance)
  ensureProfile(instance.dshHome ?? dshHome, profile)

  const argv = [execPath, ...(runtime.electron ? ['--expose-internals'] : []), entry, '--profile', profile, '--port', '0', '--no-open']
  const cwd = instance.cwd ?? homedir()
  const env: Record<string, string | undefined> = { ...process.env }
  // 实例必须用自己的 DSH_HOME；不继承 DSH_PROFILE，否则会指向桌面版 profile。
  delete env.DSH_PROFILE
  env.DSH_HOME = instance.dshHome ?? dshHome
  if (runtime.electron) env.ELECTRON_RUN_AS_NODE = '1'

  return {
    argv,
    cwd,
    env,
    describe: `${describeExecutable(execPath)} + ${entry} --profile ${profile} --port 0 --no-open（cwd ${cwd}）`,
  }
}

/**
 * WSL 实例：在发行版里跑 `dsh`。
 *
 * 两个坑写在默认命令里：
 * 1. 发行版里的 node 常常只配在 `~/.bashrc`（nvm），登录 shell 不加载 —— 所以要显式 source；
 * 2. profile 必须存在于**发行版内**的 DSH_HOME 下，bundle 由发行版里的 DSH 解析。
 *
 * 数据面不在这里：WSL 里绑 127.0.0.1 的端口 Windows 能否直连取决于网络模式，
 * 由监管器探测后决定（镜像网络模式下可直连）。
 */
export function wslSpec(instance: RemoteDeskInstance): LaunchSpec {
  if (instance.distro === undefined || instance.distro === '') {
    throw new Error(`WSL 实例 ${instance.id} 缺少 distro`)
  }
  const profile = profileOf(instance)
  const cwd = instance.cwd ?? '~'
  const command = instance.launchCommand ?? defaultWslCommand(profile, cwd)
  const argv = [
    'wsl.exe',
    '-d',
    instance.distro,
    ...(instance.user === undefined || instance.user === '' ? [] : ['-u', instance.user]),
    '--',
    'bash',
    '-lc',
    command,
  ]
  return {
    argv,
    cwd: process.cwd(),
    env: { ...process.env },
    describe: `${instance.distro} 内执行：${instance.launchCommand ?? `dsh --profile ${profile} --port 0 --no-open`}（cwd ${cwd}）`,
  }
}

/**
 * 默认的发行版内命令。
 *
 * 三条实测出来的硬约束（都踩过）：
 * 1. **单行**：多行命令在 Windows→WSL 这一跳会丢换行；
 * 2. **不做变量赋值**：wsl.exe 会把 `NAME=value` 这种 token 当环境变量赋值吃掉
 *    （`P=...` / `export P=...` / `declare P=...` 全被吞），所以路径一律内联 `$HOME`；
 * 3. **不含双引号**：JSON 用 base64 传，把引号一起消掉。
 */
function defaultWslCommand(profile: string, cwd: string): string {
  const manifest = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  const encoded = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8').toString('base64')
  const dir = `$HOME/.dsh/profiles/${profile}`
  return [
    `[ -f ${dir}/package.json ] || { mkdir -p ${dir}; printf '%s' '${encoded}' | base64 -d > ${dir}/package.json; printf '%s\\n' '[]' > ${dir}/cordis.patch.yml; }`,
    `[ -x /usr/bin/node ] || { [ -s $HOME/.nvm/nvm.sh ] && . $HOME/.nvm/nvm.sh >/dev/null 2>&1; }`,
    `command -v dsh >/dev/null 2>&1 || { echo dsh-remote-desks: 发行版里找不到 dsh，请先安装（例如 npm i -g @deepseek-ai/dsh） >&2; exit 127; }`,
    `cd ${shellQuote(cwd)} 2>/dev/null || cd $HOME`,
    `exec dsh --profile ${profile} --port 0 --no-open`,
  ].join('; ')
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function describeExecutable(execPath: string): string {
  const name = execPath.split(/[\\/]/).pop() ?? execPath
  return name.toLowerCase().includes('electron') || name.toLowerCase().includes('deepseek')
    ? `Electron(Node 模式 ${name})`
    : name
}

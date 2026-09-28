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

/** 一条启动计划：本机/WSL 走本地进程，SSH 走远端命令。 */
export type LaunchPlan =
  | { transport: 'process'; spec: LaunchSpec }
  | { transport: 'ssh'; command: string; describe: string }

/**
 * 确保 profile 存在（仅本机实例用得上）。
 *
 * profile 只是一份清单 + 一层补丁，bundle 由 DSH 发行版自己解析，所以这里**不需要包管理器**：
 * 写两个文件就够（桌面应用创建首个外部插件 profile 时也是这么做的）。
 */
export function ensureProfile(dshHome: string, profile: string): { dir: string; created: boolean } {
  const dir = join(dshHome, 'profiles', profile)
  const manifest = join(dir, 'package.json')
  if (existsSync(manifest)) return { dir, created: false }

  mkdirSync(dir, { recursive: true })
  writeFileSync(manifest, `${manifestJson(profile)}\n`, 'utf8')
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    `# 由 dsh-remote-desks 自动创建的镜像实例 profile（${profile}）。\n[]\n`,
    'utf8',
  )
  return { dir, created: true }
}

function manifestJson(profile: string): string {
  return JSON.stringify(
    {
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    },
    null,
    2,
  )
}

export function planFor(
  instance: RemoteDeskInstance,
  runtime: LocalRuntime | undefined,
  dshHome: string,
): LaunchPlan {
  if (instance.kind === 'local') {
    if (runtime === undefined) {
      throw new Error('找不到本机 DSH 发行版入口，无法启动本机实例（可用 config.entry 指定）')
    }
    return { transport: 'process', spec: localSpec(instance, runtime, dshHome) }
  }
  if (instance.kind === 'wsl') {
    if (instance.distro === undefined || instance.distro === '') {
      throw new Error(`WSL 实例 ${instance.id} 缺少 distro`)
    }
    return { transport: 'process', spec: wslSpec(instance) }
  }
  return { transport: 'ssh', ...sshSpec(instance) }
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

  const argv = [
    execPath,
    ...(runtime.electron ? ['--expose-internals'] : []),
    entry,
    '--profile',
    profile,
    '--port',
    '0',
    '--no-open',
  ]
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

/** WSL 实例：`wsl.exe` 里执行同一段 POSIX 命令。 */
export function wslSpec(instance: RemoteDeskInstance): LaunchSpec {
  if (instance.distro === undefined || instance.distro === '') {
    throw new Error(`WSL 实例 ${instance.id} 缺少 distro`)
  }
  const profile = profileOf(instance)
  const cwd = instance.cwd ?? '~'
  const command = instance.launchCommand ?? posixDshCommand(profile, cwd)
  return {
    argv: [
      'wsl.exe',
      '-d',
      instance.distro,
      ...(instance.user === undefined || instance.user === '' ? [] : ['-u', instance.user]),
      '--',
      'bash',
      '-lc',
      command,
    ],
    cwd: process.cwd(),
    env: { ...process.env },
    describe: `${instance.distro} 内执行：${instance.launchCommand ?? `dsh --profile ${profile} --port 0 --no-open`}（cwd ${cwd}）`,
  }
}

/** SSH 实例：同一段 POSIX 命令，但由远端登录 shell 执行（连接与隧道由 SshConnection 负责）。 */
export function sshSpec(instance: RemoteDeskInstance): { command: string; describe: string } {
  if (instance.host === undefined || instance.host === '') {
    throw new Error(`SSH 实例 ${instance.id} 缺少 host`)
  }
  const profile = profileOf(instance)
  const cwd = instance.cwd ?? '~'
  const command = instance.launchCommand ?? posixDshCommand(profile, cwd)
  return {
    command,
    describe: `${instance.username ?? '?'}@${instance.host} 上执行：${instance.launchCommand ?? `dsh --profile ${profile} --port 0 --no-open`}（cwd ${cwd}）`,
  }
}

/**
 * 远端（WSL / SSH）默认命令。
 *
 * 三条实测出来的硬约束，WSL 那条路径尤其重要：
 * 1. **单行**：多行命令在 Windows→WSL 这一跳会丢换行；
 * 2. **不做变量赋值**：wsl.exe 会把 `NAME=value` 这种 token 当环境变量赋值吃掉
 *    （`P=...` / `export P=...` / `declare P=...` 全被吞），所以路径一律内联 `$HOME`；
 * 3. **不含双引号**：JSON 用 base64 传，把引号一起消掉。
 *
 * 另外两条环境事实：发行版/远端里的 node 常常只配在 `~/.bashrc`（nvm），非交互 shell 不加载，
 * 所以显式 source；profile 必须存在于**远端自己的** `$HOME/.dsh` 下。
 */
export function posixDshCommand(profile: string, cwd: string): string {
  const encoded = Buffer.from(`${manifestJson(profile)}\n`, 'utf8').toString('base64')
  const dir = `$HOME/.dsh/profiles/${profile}`
  return [
    `[ -f ${dir}/package.json ] || { mkdir -p ${dir}; printf '%s' '${encoded}' | base64 -d > ${dir}/package.json; printf '%s\\n' '[]' > ${dir}/cordis.patch.yml; }`,
    `[ -x /usr/bin/node ] || { [ -s $HOME/.nvm/nvm.sh ] && . $HOME/.nvm/nvm.sh >/dev/null 2>&1; }`,
    `command -v dsh >/dev/null 2>&1 || { echo dsh-remote-desks: 远端找不到 dsh，请先安装（例如 npm i -g @deepseek-ai/dsh） >&2; exit 127; }`,
    `cd ${shellQuote(cwd)} 2>/dev/null || cd $HOME`,
    `exec dsh --profile ${profile} --port 0 --no-open`,
  ].join('; ')
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 远端 shell 的前置片段：发行版 / 远端里的 node 常常只配在 `~/.bashrc`（nvm），非交互 shell 不加载。
 * 版本探测与更新命令都要带上它，否则远端会报 "dsh: command not found"。
 */
export const POSIX_SHELL_PREFIX =
  '[ -x /usr/bin/node ] || { [ -s $HOME/.nvm/nvm.sh ] && . $HOME/.nvm/nvm.sh >/dev/null 2>&1; }'

/** WSL 里执行一条任意 shell 命令（版本探测 / 更新都走它）。 */
export function wslShellArgv(instance: RemoteDeskInstance, command: string): string[] {
  if (instance.distro === undefined || instance.distro === '') {
    throw new Error(`WSL 实例 ${instance.id} 缺少 distro`)
  }
  return [
    'wsl.exe',
    '-d',
    instance.distro,
    ...(instance.user === undefined || instance.user === '' ? [] : ['-u', instance.user]),
    '--',
    'bash',
    '-lc',
    `${POSIX_SHELL_PREFIX}; ${command}`,
  ]
}

function describeExecutable(execPath: string): string {
  const name = execPath.split(/[\\/]/).pop() ?? execPath
  return name.toLowerCase().includes('electron') || name.toLowerCase().includes('deepseek')
    ? `Electron(Node 模式 ${name})`
    : name
}

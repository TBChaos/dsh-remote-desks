import type { RemoteDeskInstance } from '../config.js'

export interface VersionProbe {
  ok: boolean
  version?: string
  /** 版本是从哪读到的（排障用）。 */
  source: string
  detail: string
}

/** 从 `dsh -V` / `--version` 的输出里取版本号。 */
export function parseVersion(text: string): string | undefined {
  const match = /\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/.exec(text)
  return match?.[1]
}

/**
 * 运行时在 `app.asar` 里 → 它是桌面应用的一部分。
 *
 * 这条必须单独判：插件无法升级桌面应用自带的运行时（那是不可变的归档），
 * 硬跑一条 `npm i -g` 只会装出一份**用不到**的副本，还让人以为升级成功了。
 */
export function isImmutableRuntime(entry: string | undefined): boolean {
  return entry !== undefined && entry.includes('app.asar')
}

/** 把 `{version}` 占位符换成具体版本；没有占位符就原样返回。 */
export function renderCommand(template: string, version: string): string {
  return template.includes('{version}') ? template.split('{version}').join(version) : template
}

export interface UpdatePlan {
  ok: boolean
  command?: string
  /** ok=false 时说明为什么不能更新。 */
  reason?: string
  /** 命令里是否带 {version} 占位符（决定能不能精确回滚）。 */
  versioned: boolean
}

/**
 * 决定这个实例该怎么更新。
 *
 * - `wsl` / `ssh`：默认 `npm i -g @deepseek-ai/dsh@{version}`（远端 dsh 通常就是这么装的）。
 * - `local`：**没有默认值**。本机那份 DSH 可能来自内置运行时、全局 npm、自己 clone……
 *   猜错只会装出一份用不到的副本，所以要求显式配置 `updateCommand`。
 * - `app.asar` 里的运行时：直接拒绝，并说明该走桌面应用的更新。
 */
export function resolveUpdatePlan(
  instance: RemoteDeskInstance,
  entry: string | undefined,
  version: string,
): UpdatePlan {
  if (isImmutableRuntime(entry)) {
    return {
      ok: false,
      reason:
        '这个实例用的是桌面版自带运行时（app.asar 内的 DSH），它是桌面应用的一部分，插件无法单独升级。请通过桌面应用自身的更新来升级；' +
        '若想独立控制版本，可另装一份 DSH 并在实例配置里用 entry/nodePath 指向它。',
      versioned: false,
    }
  }
  const configured = instance.updateCommand
  if (configured !== undefined && configured !== '') {
    return { ok: true, command: renderCommand(configured, version), versioned: configured.includes('{version}') }
  }
  if (instance.kind === 'local') {
    return {
      ok: false,
      reason:
        '本机实例没有配置 updateCommand，因此不知道该怎么升级这份 DSH（可能是全局 npm、也可能是自己 clone 的）。' +
        '请在实例配置里写明，例如：updateCommand: "npm i -g @deepseek-ai/dsh@{version}"',
      versioned: false,
    }
  }
  return { ok: true, command: `npm i -g @deepseek-ai/dsh@${version}`, versioned: true }
}

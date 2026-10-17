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

/** 版本号的形状判定：`1.2.3`、`1.2.3-rc.2` 这种才算"具体版本"，其它一律当 dist-tag。 */
export function isConcreteVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(value.trim())
}

/** 比较两个具体版本；只比 `x.y.z` 与 prerelease 段，返回 -1 / 0 / 1。认不出就返回 undefined。 */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (value: string): { core: number[]; pre: string[] } | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(value.trim())
    if (match === null) return undefined
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split('.'),
    }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === undefined || right === undefined) return undefined
  for (let index = 0; index < 3; index += 1) {
    const l = left.core[index] ?? 0
    const r = right.core[index] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  // 有 prerelease 的版本小于同号的正式版（semver 规则）。
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number(l)
    const rn = Number(r)
    const bothNumeric = Number.isSafeInteger(ln) && Number.isSafeInteger(rn) && !l.startsWith('-') && !r.startsWith('-')
    if (bothNumeric && ln !== rn) return ln < rn ? -1 : 1
    if (!bothNumeric && l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * 一次「更新」到底该拿什么当目标。
 *
 * 这块是被真实故障逼出来的：以前默认写死 `@latest`，而 npm 的 `latest` 标签未必跟着桌面版走
 * （实测桌面版 0.2.1-rc.2、`latest` 还是 0.2.0-rc.2）——于是点「更新」只是把同一个版本
 * 原地重装 76 秒，版本号纹丝不动，用户看到的就是"无法更新"。
 */
export type UpdateTargetSource = 'explicit' | 'host' | 'latest'

export interface UpdateTargetDecision {
  /** 真正拿去跑命令的目标：具体版本或 dist-tag。 */
  target: string
  source: UpdateTargetSource
  /**
   * 不用跑命令的原因：
   * - `same`：已经就是目标版本；
   * - `newer`：实例已经比目标版本还新（默认目标时才会出现，避免"更新"变降级）。
   */
  skip?: 'same' | 'newer'
  /** 给人看的一句话（写进日志与面板）。 */
  reason: string
}

export function decideUpdateTarget(input: {
  /** 用户显式指定的版本 / dist-tag；空表示"用默认"。 */
  requested?: string
  /** 实例当前版本（探测得到才有）。 */
  current?: string
  /** 桌面版自己跑的版本（宿主版本）。 */
  host?: string
}): UpdateTargetDecision {
  const requested = input.requested?.trim()
  if (requested !== undefined && requested !== '') {
    const decision: UpdateTargetDecision = {
      target: requested,
      source: 'explicit',
      reason: `按你指定的目标 ${requested}`,
    }
    if (input.current !== undefined && isConcreteVersion(requested)) {
      const order = compareVersions(input.current, requested)
      if (order === 0) return { ...decision, skip: 'same', reason: `已经是指定版本 ${requested}，无需更新` }
      if (order !== undefined && order > 0) {
        return {
          ...decision,
          skip: 'newer',
          reason: `实例已经是 ${input.current}，比指定目标 ${requested} 新；要降级请显式指定更旧的版本`,
        }
      }
    }
    return decision
  }

  const host = input.host?.trim()
  if (host === undefined || host === '') {
    return { target: 'latest', source: 'latest', reason: '拿不到桌面版版本，退回 npm 的 latest 标签' }
  }
  if (input.current !== undefined && isConcreteVersion(host)) {
    const order = compareVersions(input.current, host)
    if (order === 0) {
      return { target: host, source: 'host', skip: 'same', reason: `已经和桌面版同版本（${host}），无需更新` }
    }
    if (order !== undefined && order > 0) {
      return {
        target: host,
        source: 'host',
        skip: 'newer',
        reason: `实例已经是 ${input.current}，比桌面版（${host}）还新；要降到桌面版版本请显式指定 ${host}`,
      }
    }
  }
  return { target: host, source: 'host', reason: `默认跟桌面版同版本（${host}）` }
}

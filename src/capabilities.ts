import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

import type { RemoteDesksConfig } from './config.js'

const require = createRequire(import.meta.url)

/** Electron 在 Node 模式下也会提供的资源目录；@types/node 里没有这个字段。 */
function electronResourcesPath(): string | undefined {
  const value = (process as unknown as { resourcesPath?: unknown }).resourcesPath
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 我们依赖的宿主服务（都是软探测：缺失只影响对应能力）。 */
export const PROBED_SERVICES = [
  'webServer',
  'connection',
  'pluginManager',
  'subprocess',
  'shell',
  'credentials',
  'configEditor',
  'terminalController',
  'jobs',
  'storage',
] as const

export interface DshRuntimeProbe {
  found: boolean
  packageJson?: string
  root?: string
  entry?: string
  version?: string
  inAsar?: boolean
  via?: string
  /** 所有尝试过的策略与结果，排障时直接看这里。 */
  attempts: { via: string; ok: boolean; detail: string }[]
}

export interface CapabilityReport {
  plugin: { name: string; displayName: string; version: string; milestone: string }
  host: {
    platform: string
    arch: string
    node: string
    electron: string | null
    execPath: string
    resourcesPath: string | null
    dshHome: string | null
    dshProfile: string | null
    clientVersion: string | null
    /** 宿主自己的 web 端口（本机实例吸附的就是它）；拿不到是 null。 */
    webPort: number | null
    /** 能不能用宿主自己的令牌换会话（换不到就没法吸附）。 */
    selfAttachable: boolean
  }
  services: Record<string, boolean>
  runtime: DshRuntimeProbe
  control: { prefix: string; gate: string }
  config: {
    instances: number
    enabledInstances: number
    autoStart: number
    openMode: string
    /** 显式写了 attach: true 的实例数。 */
    attachInstances: number
    switcher: string
  }
}

function readVersion(packageJson: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: string }
    return parsed.version
  } catch {
    return undefined
  }
}

/**
 * 找本机可用的 DSH 发行版入口。
 *
 * 桌面版把发行版封在 app.asar 里，而 profile 目录下没有 node_modules 可供解析，
 * 所以单靠 `require.resolve` 不够——这里按可靠性依次尝试，并把每条策略的结果都留下来。
 * M1 拉起本机实例要用到的就是这里选中的那个入口。
 */
export function probeDshRuntime(): DshRuntimeProbe {
  const attempts: DshRuntimeProbe['attempts'] = []

  const accept = (root: string, via: string): DshRuntimeProbe => {
    const packageJson = join(root, 'package.json')
    const entry = join(root, 'lib', 'bin.js')
    if (!existsSync(packageJson)) return { found: false, attempts }
    attempts.push({ via, ok: true, detail: root })
    return {
      found: true,
      packageJson,
      root,
      entry,
      version: readVersion(packageJson),
      inAsar: root.includes('app.asar'),
      via,
      attempts,
    }
  }

  const strategies: { via: string; resolve: () => string | undefined }[] = [
    {
      // 最准的一条：宿主自己就是从这份运行时起的。
      // 桌面版里 argv[1] 是 <asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js，
      // 往上找到 node_modules 即命中 asar 内的发行版——与桌面应用自己启动 host 用的那份完全一致，
      // 不会出现"桌面跑 A 版、我们拉起的实例跑 B 版"的错位。
      via: 'process.argv[1]',
      resolve: () => {
        const argv1 = process.argv[1]
        if (argv1 === undefined || argv1 === '') return undefined
        let current = dirname(argv1)
        for (let depth = 0; depth < 8; depth += 1) {
          if (basename(current) === 'node_modules') return join(current, '@deepseek-ai', 'dsh')
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return undefined
      },
    },
    {
      via: 'DSH_DESKTOP_DSH_DIR',
      resolve: () => {
        const value = process.env.DSH_DESKTOP_DSH_DIR
        return value === undefined || value === '' ? undefined : join(value, 'node_modules', '@deepseek-ai', 'dsh')
      },
    },
    {
      // 非桌面环境（或宿主本身不是从发行版起的）才会走到这里。
      via: 'require.resolve',
      resolve: () => {
        try {
          return dirname(require.resolve('@deepseek-ai/dsh/package.json'))
        } catch {
          return undefined
        }
      },
    },
    {
      via: 'resourcesPath',
      resolve: () => {
        const resources = electronResourcesPath()
        if (resources === undefined) return undefined
        return join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
      },
    },
    {
      via: 'execPath',
      resolve: () => join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'),
    },
  ]

  for (const strategy of strategies) {
    let candidate: string | undefined
    try {
      candidate = strategy.resolve()
    } catch (error) {
      attempts.push({
        via: strategy.via,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (candidate === undefined) {
      attempts.push({ via: strategy.via, ok: false, detail: '不可用' })
      continue
    }
    if (!existsSync(join(candidate, 'package.json'))) {
      attempts.push({ via: strategy.via, ok: false, detail: `${candidate} 下没有 package.json` })
      continue
    }
    return accept(candidate, strategy.via)
  }

  return { found: false, attempts }
}

export interface CapabilityProbeInput {
  pluginName: string
  displayName: string
  version: string
  milestone: string
  controlPrefix: string
  /** 惰性求值：闸门可能随服务挂载/替换而变化。 */
  gate: () => string
  has(key: string): boolean
  config: RemoteDesksConfig
  /** 宿主自己的 web 端口；拿不到返回 undefined。 */
  webPort?: () => number | undefined
  /** 宿主是否能提供进程令牌（决定能不能吸附）。 */
  selfAttachable?: () => boolean
}

export function buildCapabilityReport(input: CapabilityProbeInput): CapabilityReport {
  const services: Record<string, boolean> = {}
  for (const key of PROBED_SERVICES) services[key] = input.has(key)

  const enabled = input.config.instances.filter((instance) => instance.enabled)

  return {
    plugin: {
      name: input.pluginName,
      displayName: input.displayName,
      version: input.version,
      milestone: input.milestone,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      execPath: process.execPath,
      resourcesPath: electronResourcesPath() ?? null,
      dshHome: process.env.DSH_HOME ?? null,
      dshProfile: process.env.DSH_PROFILE ?? null,
      clientVersion: process.env.DSH_CLIENT_VERSION ?? null,
      webPort: input.webPort?.() ?? null,
      selfAttachable: input.selfAttachable?.() ?? false,
    },
    services,
    runtime: probeDshRuntime(),
    control: { prefix: input.controlPrefix, gate: input.gate() },
    config: {
      instances: input.config.instances.length,
      enabledInstances: enabled.length,
      autoStart: input.config.autoStart.length,
      openMode: input.config.mirror.openMode,
      attachInstances: input.config.instances.filter((instance) => instance.attach === true).length,
      switcher: input.config.switcher.enabled ? input.config.switcher.corner : 'off',
    },
  }
}

import type { RemoteDeskInstance } from '../config.js'
import type { HostSelfEndpoint, LocalRuntime } from './types.js'

/** 一条吸附判定：吸附与否，以及为什么（预检、面板、日志都用同一句话）。 */
export interface AttachDecision {
  attach: boolean
  reason: string
}

/**
 * 判断一条本机实例该不该「吸附」到宿主自身。
 *
 * 起因是实测出来的一个预期落差：桌面应用打开时，本机那套 DSH（内置运行时）**本来就在跑**，
 * 用户看到 `local` 实例显示「未启动」只会以为插件坏了。而再拉起一份同样的运行时代价是
 * 两个 profile、两个端口、两份会话——完全没有意义。
 *
 * 所以规则是：
 * - `attach: true`  显式吸附（任何宿主形态都行，宿主自己的 web 端口 + 进程令牌就够）；
 * - `attach: false` 显式不吸附，永远自己拉进程；
 * - 留空自动判断：只有「宿主就是桌面版内置运行时（app.asar 里那份）」且实例没有指定别的
 *   入口 / node 时才吸附。非桌面宿主（`dsh web`、验证脚本起的临时宿主）行为不变，
 *   老配置不会被悄悄改掉语义。
 */
export function decideAttach(
  instance: RemoteDeskInstance,
  hostSelf: HostSelfEndpoint | undefined,
  runtime: LocalRuntime | undefined,
): AttachDecision {
  if (instance.kind !== 'local') {
    return { attach: false, reason: '只有本机（local）实例能吸附宿主自身' }
  }
  if (instance.attach === false) {
    return { attach: false, reason: '配置里写了 attach: false' }
  }
  if (hostSelf === undefined) {
    return {
      attach: false,
      reason: '拿不到宿主自身的 web 端口或进程令牌，无法吸附（要吸附请让宿主跑在 webServer 之上）',
    }
  }
  if (instance.attach === true) {
    return { attach: true, reason: `配置里写了 attach: true｜${hostSelf.describe}` }
  }
  if (instance.entry !== undefined && instance.entry !== '' && instance.entry !== runtime?.entry) {
    return { attach: false, reason: '实例指定了另一份 DSH 入口，按独立进程启动' }
  }
  if (instance.nodePath !== undefined && instance.nodePath !== '') {
    return { attach: false, reason: '实例指定了自己的 node / electron，按独立进程启动' }
  }
  if (runtime === undefined || runtime.inAsar !== true) {
    return { attach: false, reason: '宿主不是桌面版内置运行时（自动吸附只在桌面版生效；要吸附就写 attach: true）' }
  }
  return { attach: true, reason: `宿主就是桌面版内置运行时｜${hostSelf.describe}` }
}

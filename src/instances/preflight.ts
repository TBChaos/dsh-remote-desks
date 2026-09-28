import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { RemoteDeskInstance } from '../config.js'
import { posixDshCommand, profileOf } from './spec.js'
import type { LocalRuntime } from './types.js'

export interface PreflightCheck {
  name: string
  ok: boolean
  detail: string
}

export interface PreflightDeps {
  localRuntime: () => LocalRuntime | undefined
  dshHome: string
  resolveCredential: (name: string) => Promise<string | undefined>
}

const PROBE_TIMEOUT_MS = 8_000

/**
 * 启动前的静态检查：**不拉起实例**，只回答"能不能拉起来、缺什么"。
 *
 * 目的很直接：把"点了启动 → 报错 → 翻日志"变成"先看到缺哪一项"。检查项都是廉价的
 * （文件是否存在、端口通不通、发行版里有没有 dsh），失败也只是一条明细。
 */
export async function preflight(
  instance: RemoteDeskInstance,
  deps: PreflightDeps,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []

  let profile: string
  try {
    profile = profileOf(instance)
    checks.push({ name: 'profile 名可用', ok: true, detail: profile })
  } catch (error) {
    checks.push({ name: 'profile 名可用', ok: false, detail: describe(error) })
    return checks
  }

  if (instance.kind === 'local') {
    const runtime = deps.localRuntime()
    if (runtime === undefined) {
      checks.push({ name: 'DSH 发行版入口', ok: false, detail: '没解析到本机运行时（可用 config.entry 指定）' })
    } else {
      const entry = instance.entry ?? runtime.entry
      checks.push({
        name: 'DSH 发行版入口',
        ok: existsSync(entry) || entry.includes('app.asar'),
        detail: entry,
      })
      checks.push({
        name: '启动方式',
        ok: true,
        detail: runtime.electron ? `Electron Node 模式（${runtime.execPath}）` : `node（${runtime.execPath}）`,
      })
    }
    const cwd = instance.cwd ?? homedir()
    checks.push({ name: '工作目录存在', ok: existsSync(cwd), detail: cwd })
    const home = instance.dshHome ?? deps.dshHome
    checks.push({ name: 'DSH_HOME 可写', ok: canWrite(home), detail: home })
    checks.push({
      name: 'profile 就绪',
      ok: existsSync(join(home, 'profiles', profile, 'package.json')),
      detail: existsSync(join(home, 'profiles', profile, 'package.json')) ? '已存在' : '启动时会自动创建',
    })
    return checks
  }

  if (instance.kind === 'wsl') {
    if (instance.distro === undefined || instance.distro === '') {
      checks.push({ name: '发行版名', ok: false, detail: '缺少 distro' })
      return checks
    }
    const probe = await runCapture('wsl.exe', [
      '-d',
      instance.distro,
      ...(instance.user === undefined || instance.user === '' ? [] : ['-u', instance.user]),
      '--',
      'bash',
      '-lc',
      'command -v node || true; command -v dsh || true; [ -s $HOME/.nvm/nvm.sh ] && echo nvm',
    ])
    checks.push({
      name: '发行版可进入',
      ok: probe.ok,
      detail: probe.ok ? instance.distro : probe.stderr.trim() || `退出码 ${String(probe.code)}`,
    })
    if (probe.ok) {
      const found = probe.stdout
      checks.push({ name: 'dsh 可用', ok: found.includes('dsh') || found.includes('nvm'), detail: found.trim().replace(/\n/g, ' / ') || '未找到' })
    }
    checks.push({
      name: '启动命令',
      ok: true,
      detail: instance.launchCommand ?? `dsh --profile ${profile} --port 0 --no-open`,
    })
    return checks
  }

  // SSH
  if (instance.host === undefined || instance.host === '') {
    checks.push({ name: '主机名', ok: false, detail: '缺少 host' })
    return checks
  }
  const port = instance.port ?? 22
  const reachable = await probeTcp(instance.host, port)
  checks.push({
    name: 'SSH 端口可达',
    ok: reachable,
    detail: `${instance.host}:${String(port)}${reachable ? '' : '（连不上：检查网络/防火墙/端口）'}`,
  })

  const auth = instance.auth ?? { method: 'agent' as const }
  if (auth.method === 'privateKey') {
    checks.push({
      name: '私钥可读',
      ok: auth.privateKeyPath !== undefined && existsSync(auth.privateKeyPath),
      detail: auth.privateKeyPath ?? '缺少 privateKeyPath',
    })
  } else if (auth.method === 'password') {
    const configured = await resolveIfNamed(auth.passwordCredential, deps)
    checks.push({ name: '密码凭据', ok: configured.ok, detail: configured.detail })
  } else {
    const agent = process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    checks.push({ name: 'ssh-agent', ok: agent !== undefined, detail: agent ?? '没有 SSH_AUTH_SOCK' })
  }
  for (const [index, hop] of instance.jumpHosts.entries()) {
    const hopReachable = await probeTcp(hop.host, hop.port)
    checks.push({ name: `跳板 ${String(index + 1)} 可达`, ok: hopReachable, detail: `${hop.host}:${String(hop.port)}` })
  }
  checks.push({
    name: '远端命令',
    ok: true,
    detail: instance.launchCommand ?? posixDshCommand(profile, instance.cwd ?? '~').slice(0, 120) + '…',
  })
  return checks
}

async function resolveIfNamed(
  name: string | undefined,
  deps: PreflightDeps,
): Promise<{ ok: boolean; detail: string }> {
  if (name === undefined || name === '') return { ok: false, detail: '没有配置凭据名' }
  try {
    const value = await deps.resolveCredential(name)
    return value === undefined || value === ''
      ? { ok: false, detail: `凭据 ${name} 没有配置` }
      : { ok: true, detail: `${name}（已配置）` }
  } catch (error) {
    return { ok: false, detail: describe(error) }
  }
}

function canWrite(path: string): boolean {
  try {
    // 只判断"目录存在或父目录存在"，不真的写文件（预检不该有副作用）。
    return existsSync(path) || existsSync(join(path, '..'))
  } catch {
    return false
  }
}

async function probeTcp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host, port })
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function runCapture(
  command: string,
  argv: readonly string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...argv], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    timer.unref?.()
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, code: null, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code, stdout, stderr })
    })
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

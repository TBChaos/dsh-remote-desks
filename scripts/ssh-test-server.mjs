// 测试用的 SSH 对端（**只给本仓库的验证脚本用，不要拿去当生产服务**）。
//
// 为什么需要它：本机既没有 sshd（Windows 无服务、WSL 未装 openssh-server），又不能让
// M2 的 SSH 腿停在"未验证"上。ssh2 自带 Server 实现，于是这里起一个真实 SSH 协议的
// 对端，把 exec 交给 WSL 的 bash、把 direct-tcpip 交给 WSL 的回环地址——对本插件来说
// 它就是一台"远端 Linux"，而我们验证的是自己这一侧的连接、认证、通道与隧道代码。
//
//   node scripts/ssh-test-server.mjs [--port 2222] [--password dsh-test] [--distro Ubuntu-24.04]
//                                    [--host-key <pem 文件>] [--allow-local-shell]
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { connect as tcpConnect } from 'node:net'
import { readFileSync } from 'node:fs'
import ssh2 from 'ssh2'

// ssh2 是 CJS 包，具名导入在 ESM 下拿不到，只能从默认导出上取。
const { Server } = ssh2

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const port = Number(argOf('port', '2222'))
const password = argOf('password', randomBytes(9).toString('base64url'))
const distro = argOf('distro', 'Ubuntu-24.04')
const keyPath = argOf('host-key', '')
const user = argOf('user', 'dsh-test')

const hostKey =
  keyPath === ''
    ? generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      }).privateKey
    : readFileSync(keyPath, 'utf8')

/** 把命令交给 WSL 的 bash 执行——远端语义与真实 Linux 一致。 */
function spawnPosix(command) {
  return spawn('wsl.exe', ['-d', distro, '--', 'bash', '-lc', command], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (context) => {
    if (context.method === 'password' && context.password === password) {
      context.accept()
      return
    }
    context.reject(['password'])
  })

  client.on('ready', () => {
    console.log(`[ssh-test] 客户端已认证：${user}`)

    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, _rejectExec, info) => {
        const stream = acceptExec()
        console.log(`[ssh-test] exec：${info.command.slice(0, 160)}`)
        const child = spawnPosix(info.command)
        child.stdout.on('data', (chunk) => stream.write(chunk))
        child.stderr.on('data', (chunk) => stream.stderr.write(chunk))
        child.on('error', (error) => {
          stream.stderr.write(`spawn 失败：${error.message}\n`)
          stream.exit(127)
          stream.close()
        })
        child.on('close', (code, signal) => {
          stream.exit(typeof code === 'number' ? code : signal === null ? 0 : 1)
          stream.close()
        })
        stream.on('close', () => {
          try {
            child.kill()
          } catch {
            /* 已经退出 */
          }
        })
      })
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream.write('dsh-remote-desks 测试对端：这里不提供交互 shell\n')
        stream.exit(0)
        stream.close()
      })
    })

    // direct-tcpip：把请求的 host:port 当成"远端自己的回环地址"来连。
    client.on('tcpip', (accept, reject, info) => {
      console.log(`[ssh-test] 隧道 → ${info.destIP}:${info.destPort}`)
      const stream = accept()
      const socket = tcpConnect(info.destPort, info.destIP)
      socket.on('connect', () => {
        socket.pipe(stream).pipe(socket)
      })
      socket.on('error', (error) => {
        console.log(`[ssh-test] 隧道失败：${error.message}`)
        stream.close()
        reject?.()
      })
      stream.on('close', () => socket.destroy())
    })

    client.on('error', (error) => console.log(`[ssh-test] 客户端错误：${error.message}`))
  })
})

server.on('error', (error) => {
  console.error(`[ssh-test] 服务端错误：${error.message}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[ssh-test] 监听 127.0.0.1:${String(port)}｜用户 ${user}｜密码 ${password}｜exec 与隧道都走 WSL ${distro}`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref?.()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

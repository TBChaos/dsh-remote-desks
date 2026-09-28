import type { ClientChannel } from 'ssh2'

/** 与 ctx.subprocess 的句柄保持同形，监管器因此只有一条日志泵/停止路径。 */
export interface SubprocessHandleLike {
  done: Promise<{ exitCode: number | null; signal: string | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
  collected: {
    stdout?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
    stderr?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
  }
}

/** 单个流的最大保留量；超出就从头部丢，并把丢掉的字节数记进 base。 */
const STREAM_BUDGET_BYTES = 512 * 1024

class StreamBuffer {
  private text = ''
  /** 已经被丢弃的字节数（对应 `text[0]` 的全局偏移）。 */
  private base = 0
  private lossyFlag = false

  append(chunk: string): void {
    this.text += chunk
    if (this.text.length <= STREAM_BUDGET_BYTES) return
    const drop = this.text.length - STREAM_BUDGET_BYTES
    this.text = this.text.slice(drop)
    this.base += drop
    this.lossyFlag = true
  }

  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } {
    const local = Math.max(0, offset - this.base)
    if (local >= this.text.length) {
      return { text: '', nextOffset: this.base + this.text.length, lossy: this.lossyFlag }
    }
    return {
      text: this.text.slice(local),
      nextOffset: this.base + this.text.length,
      lossy: this.lossyFlag,
    }
  }
}

/**
 * 把一个 SSH exec 通道包装成子进程句柄。
 *
 * 远端进程的停止靠两段：先 `signal('TERM')`（走 SSH 的 signal 请求），宽限期后直接关闭通道。
 * 通道关闭不代表远端一定收工（对端可以不理会），所以调用方仍应以"状态回到 stopped"为准。
 */
export function sshProcessHandle(stream: ClientChannel, graceMs = 5_000): SubprocessHandleLike {
  const stdout = new StreamBuffer()
  const stderr = new StreamBuffer()

  stream.on('data', (chunk: Buffer) => stdout.append(chunk.toString('utf8')))
  stream.stderr.on('data', (chunk: Buffer) => stderr.append(chunk.toString('utf8')))

  let settled = false
  let resolveDone: (value: { exitCode: number | null; signal: string | null }) => void = () => {}
  const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolvePromise) => {
    resolveDone = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
  })

  stream.once('close', (code?: number | null, signal?: string | null) => {
    resolveDone({ exitCode: typeof code === 'number' ? code : null, signal: signal ?? null })
  })
  stream.once('error', () => {
    resolveDone({ exitCode: null, signal: null })
  })

  let terminateTimer: NodeJS.Timeout | undefined
  const terminate = (): void => {
    try {
      stream.signal('TERM')
    } catch {
      /* 通道可能已经关了 */
    }
    terminateTimer ??= setTimeout(() => {
      try {
        stream.close()
      } catch {
        /* 已经关了 */
      }
    }, graceMs)
    terminateTimer.unref?.()
  }

  return {
    done,
    terminate,
    waitForExit: async (signal?: AbortSignal) => {
      const timeout = new Promise<boolean>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(false), graceMs + 2_000)
        timer.unref?.()
        signal?.addEventListener('abort', () => resolvePromise(false), { once: true })
      })
      return await Promise.race([done.then(() => true), timeout])
    },
    collected: {
      stdout: { readFrom: (offset) => stdout.readFrom(offset) },
      stderr: { readFrom: (offset) => stderr.readFrom(offset) },
    },
  }
}

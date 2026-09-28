// 隔离实验：wsl.exe 的 argv 里，shell 变量赋值到底能不能活下来。
// 背景：WSL 实例的默认启动命令里 `P=$HOME/...` 被吞掉，导致后续 $P 为空。
const { spawnSync } = require('node:child_process')

const distro = process.argv[2] ?? 'Ubuntu-24.04'
const cases = [
  ['赋值+分号', "P=/tmp/xyz; echo P=[$P]"],
  ['export 赋值', "export P=/tmp/xyz; echo P=[$P]"],
  ['declare 赋值', "declare P=/tmp/xyz; echo P=[$P]"],
  ['命令替换赋值', "P=$(echo /tmp/xyz); echo P=[$P]"],
  ['只有环境变量', 'echo HOME=[$HOME]; echo U=[$USER]'],
  ['inline 展开', 'echo P=[$HOME/.dsh/profiles/demo]'],
  ['mkdir inline', 'mkdir -p $HOME/.dsh/profiles/argv-probe && echo MADE=$HOME/.dsh/profiles/argv-probe && rmdir $HOME/.dsh/profiles/argv-probe'],
]

for (const [name, command] of cases) {
  const result = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', command], { encoding: 'utf8' })
  const out = (result.stdout ?? '').trim().replace(/\n/g, ' | ')
  const err = (result.stderr ?? '').trim().replace(/\n/g, ' | ')
  console.log(`${name.padEnd(18)} → ${out}${err === '' ? '' : `  [stderr] ${err}`}`)
}

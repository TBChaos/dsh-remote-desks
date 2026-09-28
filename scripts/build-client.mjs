// 把客户端半边打成宿主能加载的形态。
//
// 官方客户端插件不是 ES 模块，而是一段 classic script：
//   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => ({ ... }) })
// 工厂里只允许 require 平台基线模块（react / react/jsx-runtime / …）。
// 这里用 esbuild 打成 CJS，再套上同一层外壳，产物形态与官方 lib/client.js 一致。
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const BASELINE = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome114'],
  jsx: 'automatic',
  write: false,
  logLevel: 'warning',
  legalComments: 'none',
  external: BASELINE,
})

const file = result.outputFiles?.[0]
if (file === undefined) throw new Error('esbuild 没有产出客户端 bundle')

const indent = (text) =>
  text
    .split('\n')
    .map((line) => (line.length === 0 ? line : `\t\t${line}`))
    .join('\n')

const output = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(pkg.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  indent(file.text.trimEnd()),
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

const destination = resolve(root, 'lib/client.js')
mkdirSync(dirname(destination), { recursive: true })
writeFileSync(destination, output)

console.log(`client bundle -> lib/client.js (${(output.length / 1024).toFixed(1)} KB)`)

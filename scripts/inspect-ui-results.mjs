// 一次性排查：从 UI 验证产出的 results.json 里翻出侧栏按钮候选。
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const results = JSON.parse(readFileSync(file, 'utf8'))
const buttons = results.dom?.buttons ?? []
console.log(`候选 ${buttons.length} 个：`)
for (const [index, button] of buttons.entries()) {
  const text = JSON.stringify(button)
  if (text.includes('会话') || text.includes('新建') || text.includes('聊天') || text.includes('工作台')) {
    console.log(`  [${index}] ${text}`)
  }
}
console.log('\n前 14 个：')
for (const button of buttons.slice(0, 14)) console.log(`  ${JSON.stringify(button)}`)

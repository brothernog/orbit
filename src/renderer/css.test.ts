import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// Todas as folhas entram na mesma pagina: @keyframes com o mesmo nome em dois arquivos faz a ultima vencer em silencio.
test('css: nomes de @keyframes sao unicos entre as folhas do renderer', () => {
  const dir = import.meta.dirname
  const seen = new Map<string, string>()
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.css')))
    for (const [, name] of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/@keyframes\s+([\w-]+)/g)) {
      assert.ok(!seen.has(name), `@keyframes ${name} em ${seen.get(name)} e ${f}`)
      seen.set(name, f)
    }
  assert.ok(seen.size > 0)
})

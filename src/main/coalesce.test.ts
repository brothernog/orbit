import test from 'node:test'
import assert from 'node:assert/strict'
import { coalesce } from './coalesce.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('coalesce: o primeiro sai na hora; uma rajada vira um envio com o valor mais novo', async () => {
  const out: string[] = []
  const c = coalesce<string>(v => out.push(v), 40)
  c.push('a')
  assert.deepEqual(out, ['a'])
  for (let i = 0; i < 500; i++) c.push('a' + 'b'.repeat(i + 1))
  assert.deepEqual(out, ['a']) // nada sai no meio da rajada
  await sleep(80)
  assert.deepEqual(out, ['a', 'a' + 'b'.repeat(500)])
})

test('coalesce: close entrega o pendente na hora e ignora o que chegar depois (nada antigo depois do fim)', async () => {
  const out: string[] = []
  const c = coalesce<string>(v => out.push(v), 1000)
  c.push('1'); c.push('12'); c.push('123')
  c.close()
  assert.deepEqual(out, ['1', '123'])
  c.push('atrasado')
  c.close()
  await sleep(20)
  assert.deepEqual(out, ['1', '123'])
})

test('coalesce: envios nunca voltam no tempo, mesmo com pausas entre rajadas', async () => {
  const out: number[] = []
  const c = coalesce<number>(v => out.push(v), 15)
  for (let i = 1; i <= 60; i++) { c.push(i); if (i % 7 === 0) await sleep(10) }
  c.close()
  assert.equal(out[out.length - 1], 60)
  assert.ok(out.length < 60)
  assert.ok(out.every((v, i) => i === 0 || v > out[i - 1]))
})

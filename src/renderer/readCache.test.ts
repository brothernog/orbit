import assert from 'node:assert/strict'
import test from 'node:test'
import { expireRead, invalidateRead, loadRead, peekRead, readSnapshot, setRead, subscribeRead } from './readCache.ts'

test('snapshots preservam null/false e TTL evita outra consulta', async t => {
  let now = 1000, calls = 0
  t.mock.method(Date, 'now', () => now)
  setRead('test:boolean', false)
  assert.equal(await loadRead('test:boolean', async () => { calls++; return true }, 100), false)
  assert.equal(calls, 0)
  now += 100
  assert.equal(await loadRead('test:boolean', async () => { calls++; return true }, 100), true)
  assert.equal(calls, 1)
  setRead('test:null', null)
  assert.equal(peekRead('test:null'), null)
})

test('refresh concorrente e unico, preserva o snapshot e notifica consumidores', async () => {
  let finish!: (value: number) => void, calls = 0, updates = 0
  setRead('test:refresh', 1)
  const off = subscribeRead('test:refresh', () => updates++)
  const loader = () => { calls++; return new Promise<number>(resolve => { finish = resolve }) }
  const first = loadRead('test:refresh', loader)
  assert.equal(loadRead('test:refresh', loader), first)
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(peekRead('test:refresh'), 1)
  finish(2)
  await first
  assert.equal(peekRead('test:refresh'), 2)
  assert.equal(updates, 1)
  off()
})

test('erro de refresh nao apaga o dado conhecido', async () => {
  setRead('test:error', 7)
  const error = new Error('consulta indisponivel')
  await assert.rejects(loadRead('test:error', async () => { throw error }), error)
  assert.equal(peekRead('test:error'), 7)
  assert.equal(readSnapshot('test:error').error, error)
  await loadRead('test:error', async () => 8)
  assert.equal(readSnapshot('test:error').error, undefined)
})

test('invalidacao ou evento novo impede resposta antiga de restaurar valores', async () => {
  let finish!: (value: number) => void
  const old = loadRead('test:identity', () => new Promise<number>(resolve => { finish = resolve }))
  await Promise.resolve()
  invalidateRead('test:identity')
  assert.equal(peekRead('test:identity'), undefined)
  await loadRead('test:identity', async () => 2)
  finish(1)
  await old
  assert.equal(peekRead('test:identity'), 2)
  const delayed = loadRead('test:identity', () => new Promise<number>(resolve => { finish = resolve }))
  await Promise.resolve()
  setRead('test:identity', 3)
  finish(2)
  await delayed
  assert.equal(peekRead('test:identity'), 3)
})

test('mutacao expira consultas antigas sem esconder o snapshot', async () => {
  setRead('test:mutation', 1)
  let finish!: (value: number) => void
  const pending = loadRead('test:mutation', () => new Promise<number>(resolve => { finish = resolve }))
  await Promise.resolve()
  expireRead('test:mutation')
  assert.equal(peekRead('test:mutation'), 1)
  finish(0)
  await pending
  assert.equal(peekRead('test:mutation'), 1)
  assert.equal(await loadRead('test:mutation', async () => 2, 60_000), 2)
})

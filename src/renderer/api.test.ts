import assert from 'node:assert/strict'
import test from 'node:test'

test('onChat: um listener com erro nao impede a entrega aos outros', async t => {
  let bridge!: (ev: unknown) => void
  ;(globalThis as any).window = { onChat: (cb: (ev: unknown) => void) => { bridge = cb; return () => {} } }
  const { onChat } = await import('./api.ts')
  const errors = t.mock.method(console, 'error', () => {})
  const got: unknown[] = []
  const offA = onChat(() => { throw new Error('boom') })
  const offB = onChat(ev => got.push(ev))
  bridge({ taskId: 1, done: true })
  assert.deepEqual(got, [{ taskId: 1, done: true }])
  assert.equal(errors.mock.callCount(), 1)
  offA(); offB()
  bridge({ taskId: 2 })
  assert.equal(got.length, 1)
})

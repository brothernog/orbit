import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRead, peekRead, setRead } from './readCache.ts'

test('IPC atualiza snapshots confirmados e eventos invalidam quotas/status', async () => {
  const previous = (globalThis as any).window
  let emit!: (event: unknown) => void
  const notifications = { sound: true }
  ;(globalThis as any).window = {
    invoke: async () => notifications,
    onChat: (listener: typeof emit) => { emit = listener }
  }
  try {
    const { api } = await import('./api.ts')
    setRead('getNotifySettings', { sound: false })
    let finish!: (value: { sound: boolean }) => void
    const old = loadRead('getNotifySettings', () => new Promise<{ sound: boolean }>(resolve => { finish = resolve }))
    await Promise.resolve()
    await api.setNotifySettings(notifications)
    finish({ sound: false })
    await old
    assert.deepEqual(peekRead('getNotifySettings'), notifications)
    const quota = { fiveHour: { utilization: 27, resets_at: null }, sevenDay: null }
    emit({ accountUsage: { accountId: 1, usage: quota } })
    assert.deepEqual(peekRead('accountUsage:1'), quota)
    setRead('accountStatus:1', { state: 'connected' })
    emit({ accountUsage: { accountId: 1, usage: null } })
    assert.equal(peekRead('accountUsage:1'), undefined)
    assert.equal(peekRead('accountStatus:1'), undefined)
  } finally { (globalThis as any).window = previous }
})

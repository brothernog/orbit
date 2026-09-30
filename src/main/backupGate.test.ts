import test from 'node:test'
import assert from 'node:assert/strict'
import { backupGate } from './backupGate.ts'

test('backup aguarda operações, bloqueia IPC até terminar e libera após erro/cancelamento', async () => {
  let idle = true, release!: () => void
  const gate = backupGate(() => { if (!idle) throw Error('agente ativo') })
  const operation = gate.invoke(() => new Promise<void>(resolve => { release = resolve }))
  await assert.rejects(gate.invoke(() => gate.exclusive(() => 1)), /pendentes/)
  release(); await operation
  idle = false
  await assert.rejects(gate.invoke(() => gate.exclusive(() => 1)), /agente ativo/)
  idle = true
  const backup = gate.invoke(() => gate.exclusive(() => new Promise<void>(resolve => { release = resolve })))
  await assert.rejects(gate.invoke(() => 1), /em andamento/)
  release(); await backup
  await assert.rejects(gate.invoke(() => gate.exclusive(() => { throw Error('disco cheio') })), /disco cheio/)
  assert.equal(await gate.invoke(() => gate.exclusive(() => null)), null)
  assert.equal(await gate.invoke(() => 2), 2)
  gate.restarting()
  await assert.rejects(gate.invoke(() => 3), /em andamento/)
})

test('worktree aguarda IPC anterior, bloqueia novos e revalida execução antes de alterar a pasta', async () => {
  let idle = true, release!: () => void, changed = false
  const gate = backupGate(() => { if (!idle) throw Error('agente ativo') })
  let earlier = gate.invoke(() => new Promise<void>(resolve => { release = resolve }))
  const waiting = gate.invoke(() => gate.exclusive(() => { changed = true }, true))
  await assert.rejects(gate.invoke(() => 1), /em andamento/)
  assert.equal(changed, false)
  release(); await earlier; await waiting
  assert.equal(changed, true)
  changed = false
  earlier = gate.invoke(() => new Promise<void>(resolve => { release = () => { idle = false; resolve() } }))
  const preparing = gate.invoke(() => gate.exclusive(() => { changed = true }, true))
  release(); await earlier
  await assert.rejects(preparing, /agente ativo/)
  assert.equal(changed, false)
  idle = true
  assert.equal(await gate.invoke(() => 2), 2)
})

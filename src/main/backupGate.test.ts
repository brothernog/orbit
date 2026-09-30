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

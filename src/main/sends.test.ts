// Mensagens retidas ate a decisao sobre contexto: reserva, transicoes atomicas, expiracao/reinicio sem iniciar nada e texto recuperavel.
// Banco sintetico, sem CLI. O fluxo com processo real (zero processo antes da decisao, uma execucao depois) e coberto por npm run e2e.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPackage, getPackage, resolvePackage, deliveryCounts, recordDelivery, finishDelivery, type Recipient } from './consent.ts'
import { openDb } from './db.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import { awaitingSend, AWAITING_MSG, createSend, endSend, getSend, listSends, moveSend, reconcileSends, reconcileStarting, recoverSend, scheduleExpiry } from './sends.ts'
import { createTask } from './tasks.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-sends-'))
const db = openDb(path.join(tmp, 't.db'))
const R: Recipient = { logicalId: 'chat:1:opencode:', provider: 'opencode', profile: '', model: null, effort: null, workspace: 'C:/x', scope: [] }
const sel = { provider: 'opencode' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let n = 0
const mk = (taskId: number) => {
  const pkg = createPackage(db, DEFAULT_LIMITS, { taskId, source: 'history', issuer: 'dashboard', recipient: R, items: [{ ref: 'hist', kind: 'history', title: 'Historico', content: `Usuario: oi ${++n}` }] })
  return { pkg, send: createSend(db, { taskId, packageId: pkg.id, text: `mensagem ${n}`, sel }) }
}

test('a tarefa e reservada: um envio aguardando por vez, outra tarefa nao e afetada', () => {
  const t1 = createTask(db, 'C:/x', 'a'), t2 = createTask(db, 'C:/x', 'b')
  const { send } = mk(t1)
  assert.equal(send.state, 'awaiting_context_approval'); assert.deepEqual(send.sel, sel)
  assert.throws(() => mk(t1), new RegExp(AWAITING_MSG.slice(0, 30))) // clique duplo / segunda mensagem enquanto aguarda
  assert.equal(awaitingSend(db, t1)!.id, send.id)
  assert.doesNotThrow(() => mk(t2)) // outra tarefa segue livre
  endSend(db, send.id, 'cancelled', 'x'); assert.doesNotThrow(() => mk(t1)) // liberada depois de resolvida
})

test('transicoes sao atomicas: so uma decisao vence; cancelar/expirar invalida o pedido e nunca deixa aprovar depois', () => {
  const t = createTask(db, 'C:/x', 'c')
  const { pkg, send } = mk(t)
  assert.equal(moveSend(db, send.id, 'awaiting_context_approval', 'starting', { decision: 'approve' }), true)
  assert.equal(moveSend(db, send.id, 'awaiting_context_approval', 'starting', { decision: 'approve' }), false) // segundo clique
  assert.equal(endSend(db, send.id, 'expired', 'tarde'), false) // o timeout que dispara depois da decisao nao faz nada
  assert.equal(getSend(db, send.id)!.state, 'starting')
  const t2 = createTask(db, 'C:/x', 'd')
  const b = mk(t2)
  assert.equal(endSend(db, b.send.id, 'cancelled', 'cancelado pelo usuario'), true)
  assert.equal(getSend(db, b.send.id)!.state, 'cancelled'); assert.equal(getPackage(db, b.pkg.id)!.state, 'cancelled')
  assert.throws(() => resolvePackage(db, { id: b.pkg.id, hash: b.pkg.hash, decision: 'approve' }), /ja foi resolvido \(cancelled\)/) // aprovar depois nao autoriza nada
  assert.equal(pkg.state, 'pending')
})

test('timeout so EXPIRA: nao inicia nada, invalida o pedido e o texto continua recuperavel; decisao antes do prazo vence o relogio', async () => {
  const t = createTask(db, 'C:/x', 'e')
  const { pkg, send } = mk(t)
  let called = 0
  scheduleExpiry(db, send.id, 20, () => { called++ })
  await sleep(80)
  const s = getSend(db, send.id)!
  assert.deepEqual([s.state, called, getPackage(db, pkg.id)!.state], ['expired', 1, 'expired'])
  assert.match(s.reason!, /sem decisao/)
  assert.deepEqual(listSends(db, t).map(x => [x.id, x.state, x.text]), [[send.id, 'expired', s.text]]) // aparece como nao enviada, com o texto
  assert.equal(recoverSend(db, send.id), s.text); assert.equal(recoverSend(db, send.id), s.text) // idempotente e sem apagar nada
  assert.deepEqual(listSends(db, t), []) // dispensado depois de recuperado
  const t2 = createTask(db, 'C:/x', 'f'); const b = mk(t2)
  scheduleExpiry(db, b.send.id, 20, () => { called++ })
  moveSend(db, b.send.id, 'awaiting_context_approval', 'starting', { decision: 'reject' }) // o usuario decidiu antes do prazo
  await sleep(80)
  assert.deepEqual([getSend(db, b.send.id)!.state, called], ['starting', 1])
})

test('reinicio: envios aguardando expiram (nada inicia), decisoes nao concluidas nao ficam presas e o texto e recuperavel', () => {
  reconcileSends(db); reconcileStarting(db) // limpa o que os testes anteriores deixaram em aberto neste banco
  const t = createTask(db, 'C:/x', 'g'), t2 = createTask(db, 'C:/x', 'h')
  const a = mk(t), b = mk(t2)
  moveSend(db, b.send.id, 'awaiting_context_approval', 'starting', { decision: 'approve' })
  assert.equal(reconcileSends(db), 1)
  assert.deepEqual([getSend(db, a.send.id)!.state, getPackage(db, a.pkg.id)!.state, getSend(db, a.send.id)!.reason], ['expired', 'expired', 'app reiniciado antes da decisao'])
  assert.equal(reconcileStarting(db), 1)
  assert.equal(getSend(db, b.send.id)!.state, 'cancelled')
  assert.equal(recoverSend(db, a.send.id), a.send.text)
  moveSend(db, b.send.id, 'cancelled', 'sent') // (simulacao) so um envio realmente iniciado vira 'sent'
  assert.equal(recoverSend(db, b.send.id), null) // envio iniciado nao e "recuperavel": ja foi enviado
})

test('consentimento e entrega sao estados separados: aprovado nao e enviado', () => {
  const t = createTask(db, 'C:/x', 'i')
  const { pkg } = mk(t)
  resolvePackage(db, { id: pkg.id, hash: pkg.hash, decision: 'approve' })
  assert.deepEqual(deliveryCounts(db, pkg.id), { confirmed: 0, sent: 0, failed: 0 }) // aprovado, ainda nao enviado
  const p = getPackage(db, pkg.id)!
  const d1 = recordDelivery(db, p, ''); assert.deepEqual(deliveryCounts(db, pkg.id), { confirmed: 0, sent: 1, failed: 0 }) // enviado, confirmacao pendente
  finishDelivery(db, d1, 'failed'); assert.deepEqual(deliveryCounts(db, pkg.id), { confirmed: 0, sent: 0, failed: 1 }) // falhou
  const d2 = recordDelivery(db, p, ''); finishDelivery(db, d2, 'confirmed', 's1'); assert.deepEqual(deliveryCounts(db, pkg.id), { confirmed: 1, sent: 0, failed: 1 }) // entregue
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

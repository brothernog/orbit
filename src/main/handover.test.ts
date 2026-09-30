import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createTask } from './tasks.ts'
import { createHandover, handoverNote, HANDOVER_TAG, HANDOVER_TITLE, normalizeHandover, originalOf, type HandoverMode } from './handover.ts'
import type { AccountUsage } from './accountUsage.ts'

const acts = [
  { line: 'Read src/a.ts' }, { line: 'Edit src/a.ts' }, { line: 'Read src/b.ts' },
  { line: 'Bash npm test', ok: false, summary: '1 falhou' }, { line: 'Write src/c.ts' }
]
const use = (pct: number): AccountUsage => ({ fiveHour: { utilization: pct, resets_at: '2099-01-01T00:00:00Z' }, sevenDay: null })

function fixture(mode: HandoverMode, usage: Record<number, AccountUsage | null> = { 2: use(80), 3: use(10) }) {
  const db = new DatabaseSync(':memory:'); migrate(db)
  const task = createTask(db, process.cwd())
  const sent: { sel: any; text: string }[] = [], notes: string[] = []
  const on = createHandover({
    db, mode: () => mode, itemChars: () => 2000, emit: () => {}, note: (_t, n) => notes.push(n),
    sendTask: async (_t, sel, text) => { sent.push({ sel, text }) },
    peers: id => [1, 2, 3].filter(x => x !== id), usage: id => usage[id] ?? null, accountName: id => `c${id}`
  })
  const todos = () => db.prepare("SELECT content, todo_state FROM memory_items WHERE task_id=? AND title=?").all(task, HANDOVER_TITLE) as any[]
  const fail = (text = 'Corrija o bug', category = 'limit') => on({ taskId: task, sel: { provider: 'claude', accountId: 1, model: 'opus' }, text, status: 'failed', category, partial: 'Vou corrigir `> Edit` o arquivo a.ts', acts })
  return { db, task, sent, notes, todos, fail, on }
}

test('resumo deterministico: editados, comandos com resultado, lidos sem repetir, fim da resposta; respeita o limite', () => {
  const n = handoverNote({ request: 'Corrija o bug', acts, partial: 'parcial', from: 'c1' })
  assert.match(n, /Pedido: Corrija o bug/)
  assert.match(n, /editados:\n- src\/a.ts\n- src\/c.ts/)
  assert.match(n, /npm test \[falhou\] \(1 falhou\)/)
  assert.match(n, /lidos:\n- src\/b.ts$/m)
  assert.ok(handoverNote({ request: 'x', acts, partial: 'p'.repeat(5000), from: 'c1' }, 400).length <= 400)
})

test('auto: pendencia criada, conta com menos uso escolhida, reenvio com o pedido original', async () => {
  const f = fixture('auto')
  f.fail()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].sel.accountId, 3)
  assert.equal(f.sent[0].sel.model, 'opus')
  assert.ok(f.sent[0].text.startsWith(HANDOVER_TAG))
  assert.equal(originalOf(f.sent[0].text), 'Corrija o bug')
  assert.equal(JSON.parse((f.db.prepare('SELECT sel FROM tasks WHERE id=?').get(f.task) as any).sel).accountId, 3)
  assert.equal(f.todos()[0].todo_state, 'open')
  // retomada concluida fecha a pendencia
  f.on({ taskId: f.task, sel: f.sent[0].sel, text: f.sent[0].text, status: 'completed', partial: '', acts: [] })
  assert.equal(f.todos()[0].todo_state, 'done')
})

test('retomada que estoura de novo so prepara (sem loop) e mantem o pedido original', () => {
  const f = fixture('auto')
  f.fail(`${HANDOVER_TAG} texto\n\nPedido original:\nCorrija o bug`)
  assert.equal(f.sent.length, 0)
  assert.match(f.notes[0], /envie "continuar"/)
  assert.match(f.todos()[0].content, /Pedido: Corrija o bug/)
})

test('prepare nao envia; off, outro erro ou outro provedor nao fazem nada; sem conta livre so avisa', () => {
  const p = fixture('prepare'); p.fail()
  assert.equal(p.sent.length, 0); assert.equal(p.todos().length, 1)
  const o = fixture('off'); o.fail()
  assert.equal(o.todos().length, 0)
  const e = fixture('auto'); e.fail('x', 'auth')
  assert.equal(e.todos().length, 0)
  const full = fixture('auto', { 2: use(100), 3: use(100) }); full.fail()
  assert.equal(full.sent.length, 0); assert.match(full.notes[0], /nenhuma outra conta/)
  assert.deepEqual(normalizeHandover({ mode: 'rm' }), { mode: 'off' })
})

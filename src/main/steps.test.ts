import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTool, createStepLog } from './steps.ts'

test('passos: classifica ferramentas e comandos do Codex', () => {
  assert.equal(classifyTool('Edit'), 'edit')
  assert.equal(classifyTool('mcp__x__read_file_range'), 'read')
  assert.equal(classifyTool('Grep'), 'search')
  assert.equal(classifyTool('Bash'), 'run')
  assert.equal(classifyTool('npm test --silent'), 'run')
  assert.equal(classifyTool('WebFetch'), 'web')
  assert.equal(classifyTool('Task'), 'other')
})

test('passos: atividade de edicao casa pelo ref, resultado marca falha e totais somam', () => {
  const log = createStepLog(() => 1000)
  log.tool('Edit', 'src/a.ts', 'e1')
  log.activity({ kind: 'edit', tool: 'Edit', path: 'src/a.ts', added: 5, removed: 2, ref: 'e1' })
  log.tool('Bash', 'npm test', 'b1'); log.result('b1', false)
  log.activity({ kind: 'read', path: 'src/b.ts', ref: 'r1' }) // so atividade (sem evento de ferramenta): vira passo
  log.activity({ kind: 'thinking', summary: 'x' })
  const snap = log.snapshot(true)
  assert.equal(snap.total, 3)
  assert.deepEqual([snap.totals.edit, snap.totals.run, snap.totals.read, snap.totals.failed, snap.totals.added, snap.totals.removed, snap.totals.files], [1, 1, 1, 1, 5, 2, 1])
  assert.equal(snap.items[0].added, 5)
  assert.ok(!('ref' in snap.items[0]))
})

test('passos: segredos saem do alvo, o limite vale e execucao sem ferramenta nao grava', () => {
  const log = createStepLog()
  assert.equal(log.json(), null)
  log.tool('Bash', 'curl -H "Authorization: Bearer abcdef123456" https://x.test/?code=1')
  assert.ok(!/abcdef123456|https:/.test(log.snapshot().items[0].target!))
  for (let i = 0; i < 150; i++) log.tool('Read', `f${i}`, `r${i}`)
  const snap = log.snapshot()
  assert.equal(snap.total, 151); assert.equal(snap.items.length, 100)
})

test('passos: gravados com a mensagem do agente, lidos pelo chat e fora do contexto enviado', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { openDb } = await import('./db.ts'), { finishRun, startRun } = await import('./runs.ts'), { createTask, taskMessages, contextFor } = await import('./tasks.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-steps-'))
  const db = openDb(path.join(dir, 't.db'))
  const log = createStepLog(); log.tool('Edit', 'a.ts', 'e1')
  const t = createTask(db, 'C:/x')
  finishRun(db, startRun(db, { taskId: t, provider: 'claude' }, 'oi'), { status: 'completed', text: 'feito', notes: [] }, log.json())
  finishRun(db, startRun(db, { taskId: t, provider: 'claude' }, 'de novo'), { status: 'completed', text: 'sem ferramenta', notes: [] })
  const agents = (taskMessages(db, t) as any[]).filter(m => m.role === 'agent')
  assert.equal(JSON.parse(agents[0].steps).items[0].target, 'a.ts')
  assert.equal(agents[1].steps, null)
  assert.ok(!JSON.stringify(contextFor(db, t, 'codex', null, false)).includes('a.ts'))
  db.close(); fs.rmSync(dir, { recursive: true, force: true })
})

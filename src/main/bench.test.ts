// Agregacao do benchmark A x B sobre banco sintetico: nenhuma chamada a CLI.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { benchSamples, compareTable, stat, totalInput } from './bench.ts'
import { openDb } from './db.ts'
import { finishRun, startRun } from './runs.ts'
import { createTask } from './tasks.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-bench-'))
const db = openDb(path.join(tmp, 't.db'))
const usage = (taskId: number, o: any) => db.prepare('INSERT INTO usage_records (task_id, run_id, delegation_id, provider, input, output, cache_read, cache_write, cache_read_included, tool_calls, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  .run(taskId, o.run ?? null, o.del ?? null, 'claude', o.input ?? null, o.output ?? null, o.cr ?? null, o.cw ?? null, o.inc ?? null, o.tools ?? null, o.ms ?? null)
const task = (first: string) => { const t = createTask(db, 'C:/x'); finishRun(db, startRun(db, { taskId: t, provider: 'claude' }, first), { status: 'completed', text: 'ok', notes: [] }); return t }

test('entrada total: cache dentro do input (Codex) ou somado (Claude); campo nao informado nunca vira 0', () => {
  assert.equal(totalInput({ input: 100, cache_read: 900, cache_write: 50, cache_read_included: 0 }), 1050)
  assert.equal(totalInput({ input: 1000, cache_read: 900, cache_write: null, cache_read_included: 1 }), 1000)
  assert.equal(totalInput({ input: 100, cache_read: null, cache_write: 0, cache_read_included: 0 }), null)
  assert.equal(totalInput({ input: null, cache_read: 1, cache_write: 1, cache_read_included: 0 }), null)
  assert.equal(stat([null, null]), null)
  assert.deepEqual(stat([10, null, 30]), { n: 2, mean: 20, min: 10, max: 30 })
})

test('amostras so das tarefas BENCH (pela 1a mensagem), separando pai e filho; tabela diz quando a diferenca esta na variacao', () => {
  const b2 = task('BENCH-2: delegue a leitura')
  usage(b2, { run: 1, input: 10, cr: 1000, cw: 0, inc: 0, output: 50, tools: 1 })
  usage(b2, { del: 1, input: 20, cr: 4000, cw: 100, inc: 0, output: 80, tools: 6 })
  usage(task('conversa normal BENCH-9: nao conta'), { run: 2, input: 999 })
  const a = benchSamples(db)
  assert.deepEqual(a.map(s => [s.bench, s.part, s.total, s.tools]), [['2', 'pai claude', 1010, 1], ['2', 'filho claude', 4120, 6]])
  const b = [{ ...a[1], total: 2000 }, { ...a[1], total: 2500 }, { ...a[0], total: 1000, output: null }]
  const t = compareTable(a, b)
  assert.match(t, /### BENCH-2 · filho claude \(rodadas: A=1, B=2\)/)
  assert.match(t, /\| entrada total \(tokens\) \| 4\.120 \(4\.120–4\.120, n=1\) \| 2\.250 \(2\.000–2\.500, n=2\) \| B menor -45% \|/)
  assert.match(t, /BENCH-2 · pai claude[\s\S]*\| entrada total \(tokens\) \| 1\.010[^|]*\| 1\.000[^|]*\| B menor -1% \|/)
  assert.match(t, /BENCH-2 · pai claude[\s\S]*\| saida \| 50 [^|]*\| — \(nao informado\) \| sem dado \|/) // nao informado nao vira 0
  assert.match(compareTable([{ ...a[0], total: 100 }, { ...a[0], total: 300 }], [{ ...a[0], total: 200 }]), /dentro da variacao/)
  assert.match(compareTable([], []), /Nenhuma tarefa de benchmark/)
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

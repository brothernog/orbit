// Relatorio "onde se gasta" sobre banco sintetico: so numeros, nada inventado para campo nao informado.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import { relativeCost, whereReport } from './usageReport.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-where-'))
const db = openDb(path.join(tmp, 't.db'))
let seq = 0
const rec = (o: any) => db.prepare('INSERT INTO usage_records (task_id, run_id, delegation_id, provider, model, session_id, input, output, cache_read, cache_write, cache_read_included, tool_calls) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(o.task, o.del ? null : ++seq, o.del ?? null, o.p ?? 'claude', o.model ?? null, o.s ?? null, o.input ?? null, o.out ?? null, o.cr ?? null, o.cw ?? null, o.inc ?? 0, o.tools ?? null)

test('onde se gasta: papel/provedor, crescimento da sessao do pai e tarefas; sem dado fica fora da soma', () => {
  assert.equal(whereReport(db), 'Nenhum registro de uso no periodo.')
  // pai claude: a entrada cresce a cada mensagem da mesma sessao
  for (let k = 1; k <= 8; k++) rec({ task: 1, s: 'sA', input: 10, cr: 1000 * k, cw: 100, out: 50, tools: 1 })
  rec({ task: 2, p: 'codex', s: 'sB', input: 5000, cr: 4000, inc: 1, out: 300 }) // codex: cache ja dentro da entrada
  rec({ task: 2, del: 1, input: 20, cr: 9000, cw: 3000, out: 700, tools: 2 })
  rec({ task: 3, s: 'sC', input: null, out: null }) // provedor nao informou
  const r = whereReport(db)
  assert.match(r, /11 execucoes/)
  assert.match(r, /Execucoes sem entrada informada: 1 \(fora das somas\)/)
  assert.match(r, /\| pai \| claude \| padrao \| 9 \| 36\.880 \|/) // 8 x (10 + 100) + 36.000 lidos; a execucao sem dado entra na contagem, nao na soma
  assert.match(r, /\| pai \| codex \| padrao \| 1 \| 5\.000 \|/) // cache incluido: nao soma de novo
  assert.match(r, /\| filho \| claude \| padrao \| 1 \| 12\.020 \|/)
  assert.match(r, /\| 1a mensagem \| 3 \| 3\.055 \|[\s\S]*\| 4a-7a \| 4 \| 5\.610 \|[\s\S]*\| 8a-15a \| 1 \| 8\.110 \|/) // cresce com a sessao
  assert.match(r, /\| #1 \| 36\.880 \|[\s\S]*\| #2 \| 17\.020 \| [^|]+\| 1 \| 5\.000 \| 1 \| 12\.020 \|/)
  assert.match(r, /\| #3 \| — \| — \| 1 \| — \|/) // tarefa so com execucao sem dado: nada vira 0
  assert.doesNotMatch(r, /NaN|undefined/)
})

test('custo relativo (estimativa) por pesos do provedor; sem peso ou sem dado fica "—", nunca 0', () => {
  assert.equal(relativeCost({ provider: 'claude', input: 10, cache_read: 1000, cache_write: 100, cache_read_included: 0 }), 10 + 100 + 125)
  assert.equal(relativeCost({ provider: 'codex', input: 5000, cache_read: 4000, cache_write: null, cache_read_included: 1 }), 1000 + 400)
  assert.equal(relativeCost({ provider: 'gemini', input: 5000, cache_read: 0, cache_write: 0, cache_read_included: 0 }), null)
  assert.equal(relativeCost({ provider: 'claude', input: 10, cache_read: null, cache_write: 5, cache_read_included: 0 }), null)
  const d = openDb(path.join(tmp, 'c.db'))
  const ins = (o: any) => d.prepare('INSERT INTO usage_records (task_id, run_id, provider, session_id, input, output, cache_read, cache_write, cache_read_included, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(o.task, ++seq, o.p ?? 'claude', o.s, o.input, 10, o.cr, o.cw, 0, o.at)
  ins({ task: 7, s: 'x', input: 10, cr: 0, cw: 9000, at: '2026-09-29 10:00:00' })
  ins({ task: 7, s: 'x', input: 10, cr: 9000, cw: 500, at: '2026-09-29 10:02:00' }) // bateu
  ins({ task: 7, s: 'x', input: 10, cr: 100, cw: 9500, at: '2026-09-29 10:04:00' }) // 2 min depois e quase nada do cache: quebra
  ins({ task: 7, s: 'x', input: 10, cr: 0, cw: 9800, at: '2026-09-29 11:00:00' }) // 56 min depois: cache expirado, nao conta
  ins({ task: 8, p: 'gemini', s: 'y', input: 3000, cr: 0, cw: 0, at: '2026-09-29 10:00:00' })
  const r = whereReport(d)
  assert.match(r, /\| pai \| claude \| padrao \| 4 \| 37\.940 \| [^|]+\| [^|]+\| [^|]+\| 36\.950 \| 100% \|/) // 40 + 9.100 lidos x 0,1 + 28.800 gravados x 1,25
  assert.match(r, /\| pai \| gemini \| padrao \| 1 \| 3\.000 \| [^|]+\| [^|]+\| [^|]+\| — \| — \|/)
  assert.match(r, /Cache que deveria ter batido: 2 mensagem\(ns\)[^;]*; 1 com menos de 50% lido do cache/)
  assert.match(r, /\| #7 \| 3 \| 2 \| 1% \|/)
  assert.match(r, /ESTIMATIVA/)
  d.close()
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

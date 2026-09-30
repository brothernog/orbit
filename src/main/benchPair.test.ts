// Tabela "so o pai" x "pai + filho": soma pai + filhos por mensagem, acumulado por rodada; parte sem dado nunca vira 0.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pairTable, stepFigures, type PairRow, type UsageLike } from './benchPair.ts'

const u = (input: number | null, cr: number | null, cw: number | null): UsageLike => ({ provider: 'claude', input, cache_read: cr, cache_write: cw, cache_read_included: 0 })

test('mensagem = pai + filhos; qualquer parte sem dado deixa a mensagem sem total', () => {
  assert.deepEqual(stepFigures({ variant: 'D', round: 1, step: 0, parent: u(10, 1000, 100), children: [u(5, 2000, 400)] }),
    { total: 3515, cost: 10 + 100 + 125 + 5 + 200 + 500, childTotal: 2405, delegations: 1 })
  assert.equal(stepFigures({ variant: 'D', round: 1, step: 0, parent: u(10, 1000, 100), children: [u(5, null, 400)] }).total, null)
  assert.equal(stepFigures({ variant: 'P', round: 1, step: 0, parent: null, children: [] }).total, null)
  assert.deepEqual(stepFigures({ variant: 'P', round: 1, step: 0, parent: u(1, 2, 3), children: [] }), { total: 6, cost: 1 + 0.2 + 3.75, childTotal: 0, delegations: 0 })
})

test('tabela P x D: por mensagem e conversa inteira; faixas sobrepostas = dentro da variacao', () => {
  const rows: PairRow[] = []
  for (const round of [1, 2]) {
    rows.push({ variant: 'P', round, step: 0, parent: u(10, 20000, 5000), children: [] })
    rows.push({ variant: 'P', round, step: 1, parent: u(10, 30000, 1000), children: [] })
    rows.push({ variant: 'D', round, step: 0, parent: u(10, 15000, 3000), children: [u(5, 20000, 9000)] })
    rows.push({ variant: 'D', round, step: 1, parent: u(10, 16000 + round, 500), children: [] })
  }
  const t = pairTable(rows, ['pergunta', '1a continuacao'])
  assert.match(t, /\| pergunta \| entrada total \| 25\.010 \(25\.010–25\.010, n=2\) \| 47\.015 \(47\.015–47\.015, n=2\) \| D maior \+88% \|/)
  assert.match(t, /\| 1a continuacao \| entrada total \| 31\.010 [^|]+\| 16\.512 \(16\.511–16\.512, n=2\) \| D menor -47% \|/)
  assert.match(t, /\| pergunta \| delegacoes \/ entrada dos filhos \(D\) \| — \| 1 \(1–1, n=2\) \/ 29\.005/)
  assert.match(t, /\| \*\*conversa inteira\*\* \| entrada total \| 56\.020 [^|]+\| 63\.527 [^|]+\| D maior \+13% \|/)
  // Uma rodada com mensagem sem dado nao entra no acumulado (nada vira 0)
  const gap = pairTable([...rows, { variant: 'P', round: 3, step: 0, parent: u(null, null, null), children: [] }, { variant: 'P', round: 3, step: 1, parent: u(1, 1, 1), children: [] }], ['pergunta', '1a continuacao'])
  assert.match(gap, /\| \*\*conversa inteira\*\* \| entrada total \| 56\.020 \(56\.020–56\.020, n=2\)/)
  assert.doesNotMatch(gap, /NaN|undefined/)
})

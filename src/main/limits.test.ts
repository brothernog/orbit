import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LIMITS, effectiveLimits, normalizeLimits } from './limits.ts'

test('limites desligados por padrao: tetos maximos e sem pausa; ligados valem os guardados', () => {
  const stored = normalizeLimits(null)
  assert.equal(stored.enabled, false)
  const off = effectiveLimits(stored)
  assert.equal(off.maxToolsPerMessage, 0)
  for (const k of ['packageChars', 'packageItems', 'itemChars', 'conclusionChars', 'queryChars', 'queryResults'] as const)
    assert.equal(off[k], normalizeLimits({ [k]: Number.MAX_SAFE_INTEGER })[k], k) // teto igual ao clamp de normalizeLimits
  assert.equal(off.approvalTimeoutMin, DEFAULT_LIMITS.approvalTimeoutMin)
  const on = normalizeLimits({ ...DEFAULT_LIMITS, enabled: true, packageChars: 3000 })
  assert.deepEqual(effectiveLimits(on), on)
  assert.equal(normalizeLimits({ enabled: 'true' }).enabled, false) // so booleano verdadeiro liga
})

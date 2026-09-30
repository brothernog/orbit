import test from 'node:test'
import assert from 'node:assert/strict'
import { returnReads, SETTINGS_READS } from './settingsReads.ts'

test('settings: todo setter devolve o mesmo formato do getter (o renderer usa o retorno como cache da leitura)', async () => {
  let saved: any = { enabled: false }
  const h: Record<string, (...a: any[]) => any> = {}
  for (const [set, get] of Object.entries(SETTINGS_READS)) {
    h[get] = () => ({ ...saved, providers: ['claude', 'codex'], capabilities: { claude: 'prompt' } })
    h[set] = (raw: any) => { saved = { enabled: !!raw?.enabled }; return saved } // formato parcial, como antes da correcao
  }
  returnReads(h)
  for (const [set, get] of Object.entries(SETTINGS_READS)) assert.deepEqual(await h[set]({ enabled: true }), h[get](), set)
})

test('settings: setter que falha nao devolve a leitura; par ausente falha na montagem', async () => {
  const h: Record<string, (...a: any[]) => any> = {}
  for (const [set, get] of Object.entries(SETTINGS_READS)) { h[get] = () => ({}); h[set] = async () => { throw Error('recusado') } }
  returnReads(h)
  await assert.rejects(h.setDelegationSettings({}), /recusado/)
  assert.throws(() => returnReads({ setContextLimits: () => ({}) }), /sem par/)
})

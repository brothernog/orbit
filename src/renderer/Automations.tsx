import { useState } from 'react'
import { api, errText } from './api'
import { useCachedRead } from './useCachedRead'

// Automacoes (src/main/automations.ts). Por ora uma regra: trocar de conta Claude perto do limite. Ordem = ordem das contas acima.
type Rule = { id: string; enabled: boolean; when: { kind: 'usage_above'; percent: number }; then: { kind: 'switch_account'; order: number[] } }
const ID = 'switch-account'
const base: Rule = { id: ID, enabled: false, when: { kind: 'usage_above', percent: 95 }, then: { kind: 'switch_account', order: [] } }

export function Automations() {
  const read = useCachedRead<Rule[]>('getAutomations', () => api.getAutomations())
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  const rules = read.data
  if (!rules) return <small>{err || 'Carregando…'}</small>
  const r = rules.find(x => x.id === ID) ?? base
  const put = (patch: Partial<Rule>) => api.setAutomations([...rules.filter(x => x.id !== ID), { ...r, ...patch }]).then(read.set, e => setErr(errText(e)))
  return (
    <div className="deleg">
      <label className="check">
        <input type="checkbox" checked={r.enabled} onChange={e => put({ enabled: e.target.checked })} /> Trocar de conta quando o uso passar de
        <span className="lim-in"><input type="number" min={1} max={100} defaultValue={r.when.percent} key={r.when.percent} aria-label="Percentual do limite"
          onBlur={e => +e.target.value !== r.when.percent && put({ when: { kind: 'usage_above', percent: +e.target.value } })} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /><small>%</small></span>
      </label>
      <small>Antes de cada envio, usa a próxima conta com uso livre, na ordem acima. O histórico só segue se você aprovar.</small>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

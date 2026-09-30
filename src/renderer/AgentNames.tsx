import { useEffect, useMemo, useState } from 'react'
import { AGENTS, api, errText, type Catalog } from './api'
import { Dropdown, type Opt } from './Dropdown'
import { Icon, PROVIDER } from './icons'
import './agentNames.css'

// Sub-aba "Agentes" das Configuracoes: o usuario da um nome a um provedor + modelo (+ esforco) e os agentes da dashboard passam a
// resolver o nome sozinhos ("delegue para o Fabricio"). Componente isolado: usa so `api` (IPC getAgentAliases/setAgentAliases/catalog)
// e o Dropdown do redesign. Encaixe: <AgentNames /> dentro de uma secao/aba de Settings.tsx.
type Row = { name: string; provider: string; model: string; effort: string }
const empty = (): Row => ({ name: '', provider: '', model: '', effort: '' })
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
const providerOpts: Opt[] = AGENTS.map(p => ({ value: p, label: PROVIDER[p]?.label ?? p }))

export function AgentNames() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [saved, setSaved] = useState('[]')
  const [catalogs, setCatalogs] = useState<Record<string, Catalog | 'loading' | 'error'>>({})
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = () => api.getAgentAliases().then((v: any[]) => {
    const r = v.map(a => ({ name: a.name, provider: a.provider, model: a.model, effort: a.effort ?? '' }))
    setRows(r); setSaved(JSON.stringify(r))
  }, e => setErr(errText(e)))
  useEffect(() => { load() }, [])

  // Catalogo do provedor (modelos e esforcos), carregado uma vez por provedor usado nas linhas.
  useEffect(() => {
    for (const p of new Set((rows ?? []).map(r => r.provider).filter(Boolean)))
      if (!catalogs[p]) {
        setCatalogs(c => ({ ...c, [p]: 'loading' }))
        api.catalog(p).then((c: Catalog) => setCatalogs(x => ({ ...x, [p]: c })), () => setCatalogs(x => ({ ...x, [p]: 'error' })))
      }
  }, [rows])

  const problems = useMemo(() => {
    const seen = new Set<string>()
    return (rows ?? []).map(r => {
      const k = fold(r.name)
      const dup = !!k && seen.has(k)
      seen.add(k)
      if (!r.name.trim()) return 'Dê um nome'
      if (dup) return 'Nome repetido'
      if (AGENTS.includes(k)) return 'Este é o nome de um provedor'
      if (!r.provider) return 'Escolha o provedor'
      if (!r.model) return 'Escolha o modelo'
      return ''
    })
  }, [rows])
  const dirty = rows !== null && JSON.stringify(rows) !== saved
  const set = (i: number, patch: Partial<Row>) => { setOk(false); setRows(rs => rs!.map((r, j) => (j === i ? { ...r, ...patch } : r))) }

  const save = () => {
    setErr(''); setOk(false); setBusy(true)
    api.setAgentAliases(rows!.map(r => ({ name: r.name.trim(), provider: r.provider, model: r.model, effort: r.effort || undefined })))
      .then((v: any[]) => { const r = v.map(a => ({ name: a.name, provider: a.provider, model: a.model, effort: a.effort ?? '' })); setRows(r); setSaved(JSON.stringify(r)); setOk(true) }, e => setErr(errText(e)))
      .finally(() => setBusy(false))
  }

  if (!rows) return <small>{err || 'Carregando…'}</small>
  return (
    <div className="an">
      <p className="an-lede">Dê um nome a um provedor e modelo para delegar por nome: <em>“delegue para o Fabricio”</em>.</p>
      {rows.length === 0 && <small>Nenhum agente nomeado ainda.</small>}
      <ul className="an-list">
        {rows.map((r, i) => {
          const cat = r.provider ? catalogs[r.provider] : undefined
          const c = typeof cat === 'object' ? cat : null
          const models: Opt[] = (c?.models ?? []).map(m => ({ value: m.id, label: m.label ?? m.id }))
          const efforts = c ? (c.models.find(m => m.id === r.model)?.efforts ?? c.efforts) : []
          return (
            <li key={i} className="an-row">
              <input aria-label={`Nome do agente ${i + 1}`} placeholder="Nome (ex.: Fabricio)" maxLength={40} value={r.name} onChange={e => set(i, { name: e.target.value })} />
              <Dropdown down label={`Provedor do agente ${i + 1}`} placeholder="Provedor" value={r.provider} options={providerOpts}
                onChange={v => set(i, { provider: v, model: '', effort: '' })} />
              <Dropdown down search custom={!!c?.allowCustomModel} label={`Modelo do agente ${i + 1}`} value={r.model} options={models}
                placeholder={!r.provider ? 'Modelo' : cat === 'loading' || !cat ? 'Carregando modelos…' : cat === 'error' ? 'Catálogo indisponível' : 'Modelo'}
                disabled={!r.provider || !c} onChange={v => set(i, { model: v, effort: c?.models.find(m => m.id === v)?.efforts?.includes(r.effort) ?? c?.efforts.includes(r.effort) ? r.effort : '' })} />
              {efforts.length > 0 && (
                <Dropdown down label={`Esforço do agente ${i + 1}`} placeholder="Esforço" value={r.effort} options={[{ value: '', label: 'Padrão do modelo' }, ...efforts.map(e => ({ value: e, label: e }))]}
                  onChange={v => set(i, { effort: v })} />
              )}
              <button type="button" className="icon sm" aria-label={`Remover o agente ${r.name || i + 1}`} title="Remover" onClick={() => { setOk(false); setRows(rs => rs!.filter((_, j) => j !== i)) }}><Icon n="close" size={16} /></button>
              {problems[i] && dirty && <small className="an-problem" role="status">{problems[i]}</small>}
            </li>
          )
        })}
      </ul>
      <div className="an-actions">
        <button type="button" onClick={() => { setOk(false); setRows(rs => [...rs!, empty()]) }}><Icon n="plus" size={14} /> Adicionar agente</button>
        <button type="button" className="primary" disabled={!dirty || busy || problems.some(Boolean)} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>
        {ok && <small className="an-ok" role="status">Salvo. Vale na próxima execução.</small>}
      </div>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

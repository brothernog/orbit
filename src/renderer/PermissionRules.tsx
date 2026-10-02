import { useEffect, useState } from 'react'
import { api, errText, name } from './api'
import { Icon, PROVIDER } from './icons'
import { useCachedRead } from './useCachedRead'
import './permission.css'

type Settings = { prompt: boolean; timeoutMin: number; codexSandbox: 'workspace-write' | 'danger-full-access'; codexNetwork: boolean; opencodeAuto: boolean; claudeAuto: boolean }
type Rule = { id: number; provider: string; kind: 'bash' | 'tool'; pattern: string; decision: 'allow' | 'deny'; risk: 'low' | 'broad' | 'destructive'; project: string }
type Assess = { risk: 'low' | 'broad' | 'destructive'; reason: string }
type Recent = { id: number; provider: string; summary: string; state: string; created_at: string }
const STATE_PT: Record<string, string> = { allowed_once: 'permitido uma vez', allowed_always: 'sempre permitido', allowed_rule: 'permitido por regra', denied: 'negado', denied_rule: 'negado por regra', expired: 'expirou (negado)', pending: 'pendente' }
const AGENT_OPTS = ['claude', 'opencode'] // regras: o Claude as aplica no pop-up; o OpenCode as recebe como permissoes. O Codex so tem politica de sandbox.

// Um modo por agente (radio): combinacoes que a CLI nao distingue nao aparecem como duas caixas marcadas.
const CLAUDE_MODES: [string, string, Partial<Settings>][] = [
  ['prompt', 'Perguntar em pop-up', { prompt: true, claudeAuto: false }],
  ['auto', 'Automático: o Claude aprova sozinho o que for seguro', { prompt: false, claudeAuto: true }],
  ['deny', 'Negar o que não tiver regra', { prompt: false, claudeAuto: false }],
]
const CODEX_MODES: [string, string, Partial<Settings>][] = [
  ['sandbox', 'Sandbox: só a pasta do projeto, sem rede', { codexSandbox: 'workspace-write', codexNetwork: false }],
  ['net', 'Sandbox com rede', { codexSandbox: 'workspace-write', codexNetwork: true }],
  ['full', 'Sem sandbox (permitir tudo)', {}],
]

// Secao "Permissoes" das Configuracoes: "Sempre permitir" por agente. Claude pergunta pelo pop-up (<PermissionPrompt />); Codex e OpenCode
// nao tem prompt no modo headless, entao a escolha vira politica nativa (sandbox/rede, --auto). Componente isolado (so `api`).
// Encaixe: <PermissionRules /> em uma secao/aba de Settings.tsx.
export function PermissionRules() {
  const settings = useCachedRead<Settings>('getPermissionSettings', () => api.getPermissionSettings())
  const ruleRead = useCachedRead<Rule[]>('listPermissionRules', () => api.listPermissionRules())
  const requestRead = useCachedRead<Recent[]>('listPermissionRequests', () => api.listPermissionRequests())
  const s = settings.data, rules = ruleRead.data ?? []
  const recent = (requestRead.data ?? []).filter(r => r.state !== 'pending').slice(0, 10)
  const [writeErr, setErr] = useState('')
  const readError = settings.error || ruleRead.error || requestRead.error
  const err = writeErr || (readError ? errText(readError) : '')
  const [fullAck, setFullAck] = useState(false)
  const [form, setForm] = useState({ provider: 'claude', kind: 'bash', pattern: '', decision: 'allow', project: '' })
  const [assess, setAssess] = useState<Assess | null>(null)
  const [ack, setAck] = useState(false)
  const [games, setGames] = useState<string[]>([])

  const load = () => Promise.all([ruleRead.reload(), requestRead.reload()]).catch(() => {})
  useEffect(() => { api.listGames().then(setGames, () => {}) }, [])
  useEffect(() => { // risco do padrao digitado, para o aviso aparecer ANTES de salvar
    setAck(false)
    if (!form.pattern.trim()) { setAssess(null); return }
    const t = setTimeout(() => api.assessPermissionRule(form.kind, form.pattern).then(setAssess, () => setAssess(null)), 200)
    return () => clearTimeout(t)
  }, [form.pattern, form.kind])

  if (!s) return <small>{err || 'Carregando…'}</small>
  const save = (patch: Partial<Settings>, acknowledged = false) => {
    setErr('')
    api.setPermissionSettings({ ...s, ...patch, acknowledged }).then((v: Settings) => settings.set({ ...s, ...v }), (e: any) => setErr(errText(e)))
  }
  const add = () => {
    setErr('')
    api.addPermissionRule({ ...form, acknowledged: ack }).then(() => { setForm(f => ({ ...f, pattern: '' })); setAssess(null); load() }, (e: any) => setErr(errText(e)))
  }
  const claudeMode = s.claudeAuto ? 'auto' : s.prompt ? 'prompt' : 'deny'
  const codexMode = fullAck || s.codexSandbox === 'danger-full-access' ? 'full' : s.codexNetwork ? 'net' : 'sandbox'
  const needAck = !!assess && assess.risk !== 'low' && form.decision === 'allow'
  const refused = !!assess && assess.risk === 'destructive' && form.kind === 'bash' && (form.pattern.trim() === '*' || form.pattern.trim().endsWith(' *')) && form.decision === 'allow'

  return (
    <div className="pr">
      <section>
        <h2>Por agente</h2>
        <div className="pr-agent">
          <b>{PROVIDER.claude.label}</b>
          <div role="radiogroup" aria-label={`Permissões do ${PROVIDER.claude.label}`}>
            {CLAUDE_MODES.map(([v, label, patch]) => <label key={v} className="check"><input type="radio" name="pr-claude" checked={claudeMode === v} onChange={() => save(patch)} /> {label}</label>)}
            {s.prompt && <label className="pr-inline">Responder em até <input type="number" min={1} max={60} value={s.timeoutMin} onChange={e => save({ timeoutMin: +e.target.value })} /> min</label>}
          </div>
        </div>
        <div className="pr-agent">
          <b>{PROVIDER.codex.label}</b>
          <div role="radiogroup" aria-label={`Permissões do ${PROVIDER.codex.label}`}>
            {CODEX_MODES.map(([v, label, patch]) => <label key={v} className="check"><input type="radio" name="pr-codex" checked={codexMode === v}
              onChange={() => { if (v === 'full') setFullAck(true); else { setFullAck(false); save(patch) } }} /> {label}</label>)}
            {(fullAck || s.codexSandbox === 'danger-full-access') && (
              <p className="pp-warn" role="alert">
                <Icon n="alert" size={16} /> Sem sandbox o Codex executa <b>qualquer comando</b>, em qualquer pasta.{' '}
                {s.codexSandbox !== 'danger-full-access' && <button type="button" onClick={() => { save({ codexSandbox: 'danger-full-access' }, true); setFullAck(false) }}>Entendo o risco, ativar</button>}
              </p>
            )}
          </div>
        </div>
        <div className="pr-agent">
          <b>{PROVIDER.opencode.label}</b>
          <div role="radiogroup" aria-label={`Permissões do ${PROVIDER.opencode.label}`}>
            <label className="check"><input type="radio" name="pr-opencode" checked={!s.opencodeAuto} onChange={() => save({ opencodeAuto: false })} /> Negar o que não tiver regra</label>
            <label className="check"><input type="radio" name="pr-opencode" checked={s.opencodeAuto} onChange={() => save({ opencodeAuto: true })} /> Aprovar tudo que não for negado por regra</label>
          </div>
        </div>
      </section>

      <section>
        <h2>Regras</h2>
        {ruleRead.data === undefined ? <small>{ruleRead.error ? 'Não foi possível carregar as regras.' : 'Carregando regras…'}</small> : rules.length === 0 && <small>Nenhuma regra. “Sempre permitir” no pop-up cria regras aqui.</small>}
        <ul className="pr-rules">
          {rules.map(r => (
            <li key={r.id}>
              <span className={`pr-dec ${r.decision}`}>{r.decision === 'allow' ? 'Permitir' : 'Negar'}</span>
              <span className="pr-who">{PROVIDER[r.provider]?.label ?? r.provider}</span>
              <code title={r.pattern}>{r.pattern}</code>
              {(r.kind === 'tool' || r.project || r.risk !== 'low') && <small>{[r.kind === 'tool' && 'ferramenta', r.project && name(r.project), r.risk !== 'low' && (r.risk === 'destructive' ? 'destrutivo' : 'amplo')].filter(Boolean).join(' · ')}</small>}
              <button type="button" className="icon sm" aria-label={`Remover a regra ${r.pattern}`} title="Remover" onClick={() => api.removePermissionRule(r.id).then(load, (e: any) => setErr(errText(e)))}><Icon n="close" size={16} /></button>
            </li>
          ))}
        </ul>
        <details>
          <summary>Nova regra</summary>
          <form className="pr-form" onSubmit={e => { e.preventDefault(); add() }}>
            <select aria-label="Agente" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>{AGENT_OPTS.map(p => <option key={p} value={p}>{PROVIDER[p].label}</option>)}</select>
            <select aria-label="Decisão" value={form.decision} onChange={e => setForm({ ...form, decision: e.target.value })}><option value="allow">Permitir</option><option value="deny">Negar</option></select>
            <select aria-label="Tipo" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}><option value="bash">Comando</option><option value="tool">Ferramenta</option></select>
            <select aria-label="Projeto" value={form.project} onChange={e => setForm({ ...form, project: e.target.value })}><option value="">Todos os projetos</option>{games.map(g => <option key={g} value={g}>{name(g)}</option>)}</select>
            <input aria-label="Padrão" placeholder={form.kind === 'bash' ? 'npm run *  ou  npm run typecheck' : 'WebFetch  ou  mcp__servidor__*'} maxLength={300} value={form.pattern} onChange={e => setForm({ ...form, pattern: e.target.value })} />
            <button className="primary" disabled={!form.pattern.trim() || refused || (needAck && !ack)}>Adicionar</button>
            {assess && assess.risk !== 'low' && form.decision === 'allow' && (
              <p className="pp-warn pr-warn" role="alert">
                {refused ? <>Regra ampla recusada: {assess.reason}. Permita o comando exato, se for o que quer.</> : (
                  <label className="check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> Entendo o risco: esta regra é <b>{assess.risk === 'destructive' ? 'destrutiva' : 'ampla'}</b> ({assess.reason}).</label>
                )}
              </p>
            )}
            <small className="pr-note">Curinga só vale para comandos simples; encadeados (<code>&amp;&amp;</code> <code>;</code> <code>|</code>) sempre perguntam.</small>
          </form>
        </details>
        {recent.length > 0 && (
          <details>
            <summary>Últimos pedidos ({recent.length})</summary>
            <ul className="pr-recent">{recent.map(r => <li key={r.id}><span className="pr-who">{PROVIDER[r.provider]?.label ?? r.provider}</span><code title={r.summary}>{r.summary.split('\n')[0]}</code><small>{STATE_PT[r.state] ?? r.state}</small></li>)}</ul>
          </details>
        )}
        {err && <small className="err" role="alert">{err}</small>}
      </section>
    </div>
  )
}

// Peças comuns dos painéis de engine (Blender agora, Unity depois): estado do organizador, sonda do executável,
// prévia do comando preparado para revisão humana e execuções com diagnóstico. Mesmo modelo do GodotPanel.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errText, onChat } from './api'
import type { CommandRun, CommandRunSummary, ProjectCommand } from '../main/commands'
import type { EngineConfig } from '../main/engines'
import type { EngineDiagnostic, EngineProbe, EngineReview, FlowEngine } from '../main/engineFlow'
import './godot.css'
import './engine.css'

export type EngineState<D> = { organizer: { id: string; name: string; config: EngineConfig } | null; available: boolean; details: D | null; error?: string }
type Prepared = { command: ProjectCommand; review: EngineReview[] }
type Diagnostics = { run: CommandRun; items: EngineDiagnostic[]; errorCount: number; warningCount: number; totalLines: number }
const statusText: Record<string, string> = { running: 'Executando', completed: 'Concluído', failed: 'Falhou', cancelled: 'Cancelado' }
const sameCommand = (a?: ProjectCommand | null, b?: ProjectCommand | null) => !!a && !!b && a.name === b.name && a.program === b.program && a.purpose === b.purpose && JSON.stringify(a.args) === JSON.stringify(b.args)

type Props = { taskId: number; game: string; disabled: boolean; commands: ProjectCommand[]; runs: CommandRunSummary[]; onPrepared: () => Promise<void> }
// O painel da engine só fornece os fatos do projeto e o formulário; tudo o mais é comum.
export function EnginePanel<D>({ engine, label, taskId, game, disabled, commands, runs, onPrepared, facts, form, footer }: Props & {
  engine: FlowEngine; label: string
  facts: (details: D, probe: EngineProbe | null) => ReactNode
  form: (o: { busy: boolean; blocked: boolean; details: D; prepare: (action: string, args: object) => void; changed: () => void }) => ReactNode
  footer?: ReactNode
}) {
  const [state, setState] = useState<EngineState<D> | null>(null), [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [probe, setProbe] = useState<EngineProbe | null>(null), [prepared, setPrepared] = useState<Prepared | null>(null), [busy, setBusy] = useState(false)
  const request = useRef(0), mounted = useRef(true), expanded = useRef(false)
  const load = async (details = expanded.current) => {
    const n = ++request.current
    setLoading(true)
    try {
      const result: EngineState<D> = await api.engineState(taskId, engine, details)
      if (!mounted.current || n !== request.current) return
      setState(result); setError('')
    } catch (e) { if (mounted.current && n === request.current) { setState(previous => previous ? { ...previous, details: null } : null); setPrepared(null); setError(errText(e)) } }
    finally { if (mounted.current && n === request.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true
    setState(null); setPrepared(null); setProbe(null)
    void load()
    const off = onChat(e => { if (e.groupsChanged || e.worktreesChanged === game) { setPrepared(null); setProbe(null); void load() } })
    return () => { mounted.current = false; ++request.current; off() }
  }, [taskId, game, engine])
  const perform = async (f: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await f() } catch (e) { if (mounted.current) setError(errText(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  if (!state?.organizer?.config.enabled || (!state.available && !state.error)) return null
  const details = state.details, active = runs.some(r => r.status === 'running'), blocked = busy || loading || disabled || active
  const engineRuns = runs.filter(r => r.name.startsWith(`${label} · `))
  const unchanged = !!prepared && sameCommand(commands.find(c => c.name === prepared.command.name), prepared.command)
  const prepare = (action: string, args: object) => void perform(async () => {
    const n = request.current, result: Prepared = await api.prepareEngineCommand(taskId, engine, action, args)
    if (mounted.current && n === request.current) { setPrepared(result); await onPrepared() }
  })
  return <details className={`workflow engine-panel ${engine}-panel`} name="task-tools" onToggle={e => { expanded.current = e.currentTarget.open; setOpen(expanded.current); if (expanded.current) void load(true) }}>
    <summary>{label} local <span>{state.organizer.name}</span></summary>
    {open && <div className="workflow-body">
      <div className="godot-head"><p className="muted">Na pasta desta tarefa, incluindo worktree.</p><button className="text-btn" disabled={busy || loading} onClick={() => { setPrepared(null); setProbe(null); void load() }}>{loading ? 'Atualizando…' : 'Atualizar projeto'}</button></div>
      {state.error && <p role="alert" className="err">{state.error}</p>}
      {loading && <p role="status" className="muted">Consultando projeto…</p>}
      {details && <>
        {facts(details, probe)}
        <div><button disabled={blocked} onClick={() => perform(async () => { const n = request.current, result: EngineProbe = await api.engineProbe(taskId, engine); if (mounted.current && n === request.current) setProbe(result) })}>Verificar instalação {label}</button>{probe && <p role="status"><b>{label} {probe.version}</b><small>{probe.exe}</small></p>}</div>
        {form({ busy, blocked, details, prepare, changed: () => setPrepared(null) })}
        {prepared && <div className="godot-preview" aria-label={`Comando ${label} preparado`}><b>{prepared.command.name}</b><code>{prepared.command.program} {JSON.stringify(prepared.command.args)}</code>
          {prepared.review.map(r => <details key={r.file} open><summary>Conteúdo que será executado: <code>{r.file}</code></summary><pre className="engine-review" aria-label={`Conteúdo de ${r.file}`}>{r.text}</pre>{r.truncated && <small>Prévia cortada em 20.000 caracteres; revise o arquivo completo.</small>}</details>)}
          <small>{unchanged ? 'Preparado; execute quando os argumentos estiverem corretos.' : 'O comando foi alterado. Prepare novamente antes de executar.'}{!!prepared.review.length && ' Se o arquivo mudar depois da preparação, a execução é recusada.'}</small>
          <div className="step-actions"><button className="primary" disabled={blocked || !unchanged} onClick={() => perform(async () => { await api.runProjectCommand(taskId, prepared.command.name) })}>Executar comando {label}</button><button className="text-btn" disabled={busy} onClick={() => setPrepared(null)}>Fechar prévia</button></div>
        </div>}
        {!!engineRuns.length && <div className="godot-runs">{engineRuns.map(run => <EngineRun key={run.id} taskId={taskId} engine={engine} label={label} run={run} />)}</div>}
        {footer}
      </>}
      {error && <p className="err" role="alert">{error}</p>}
    </div>}
  </details>
}

export function EngineRun({ taskId, engine, label, run }: { taskId: number; engine: FlowEngine; label: string; run: CommandRunSummary }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef(0)
  useEffect(() => {
    const invalidate = () => { ++request.current; setDiagnostics(null) }
    invalidate()
    const off = onChat(e => { if (e.taskId === taskId && e.commandOutput?.id === run.id) invalidate() })
    return () => { ++request.current; off() }
  }, [taskId, run.id, run.status, run.truncated])
  const act = async (f: () => Promise<void>) => { setBusy(true); setError(''); try { await f() } catch (e) { setError(errText(e)) } finally { setBusy(false) } }
  const shown = diagnostics?.items.filter(i => i.severity !== 'info') ?? []
  return <details className="godot-run"><summary>#{run.id} {run.name} · {statusText[run.status]} · exit {run.exit_code ?? '—'}</summary><div className="godot-run-body">
    <small>{run.workspace}</small>
    {run.error && <p className="err">{run.error}</p>}
    <div className="step-actions"><button disabled={busy} onClick={() => act(async () => { const n = request.current, result: Diagnostics = await api.engineDiagnostics(taskId, engine, run.id); if (n === request.current) setDiagnostics(result) })}>{busy ? 'Consultando…' : 'Consultar diagnóstico'}</button>{run.status === 'running' && <button disabled={busy} aria-label={`Cancelar ${label} #${run.id}`} onClick={() => act(() => api.cancelProjectCommand(taskId, run.id))}>Cancelar {label}</button>}</div>
    {diagnostics && <div role="status"><p>{diagnostics.errorCount} erro(s) · {diagnostics.warningCount} aviso(s)</p><ul className="godot-diagnostics">{shown.map((item, i) => <li key={i} className={item.severity}><p>{item.message}{item.count > 1 && ` (${item.count} ocorrências)`}</p>{item.file && <code>{item.file}{item.line != null && `:${item.line}`}</code>}</li>)}</ul>{!shown.length && <p className="muted">Nenhum diagnóstico reconhecido. Confira os logs completos e o resultado esperado; exit 0 não comprova o resultado.</p>}{!!diagnostics.run.truncated && <p className="muted">A saída registrada foi cortada. Este diagnóstico cobre somente a parte disponível.</p>}</div>}
    <p className="muted">Logs completos em Comandos do projeto → Histórico desta tarefa.</p>
    {error && <p className="err" role="alert">{error}</p>}
  </div></details>
}

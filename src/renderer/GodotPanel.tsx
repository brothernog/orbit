import { useEffect, useRef, useState } from 'react'
import { api, errText, onChat } from './api'
import type { CommandRun, CommandRunSummary, ProjectCommand } from '../main/commands'
import type { GodotAction, GodotConfig, GodotDiagnostic, GodotProject, godotProbe } from '../main/godot'
import './godot.css'

type State = { organizer: { id: string; name: string; config: GodotConfig } | null; available: boolean; project: GodotProject | null; error?: string }
type Probe = Awaited<ReturnType<typeof godotProbe>>
type Diagnostics = { run: CommandRun; items: GodotDiagnostic[]; errorCount: number; warningCount: number; totalLines: number }
const actionLabels: Record<GodotAction, string> = { import: 'Importar recursos', check: 'Verificar script GDScript', run: 'Executar jogo ou cena', editor: 'Abrir editor', export: 'Exportar para Windows' }
const statusText: Record<string, string> = { running: 'Executando', completed: 'Concluído', failed: 'Falhou', cancelled: 'Cancelado' }

export function GodotPanel({ taskId, game, disabled, commands, runs, onPrepared }: { taskId: number; game: string; disabled: boolean; commands: ProjectCommand[]; runs: CommandRunSummary[]; onPrepared: (command: ProjectCommand) => void }) {
  const [state, setState] = useState<State | null>(null), [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [probe, setProbe] = useState<Probe | null>(null), [action, setAction] = useState<GodotAction>('import'), [script, setScript] = useState(''), [scene, setScene] = useState(''), [preset, setPreset] = useState(''), [output, setOutput] = useState(''), [log, setLog] = useState(''), [debug, setDebug] = useState(false), [headless, setHeadless] = useState(false)
  const [prepared, setPrepared] = useState<ProjectCommand | null>(null), [busy, setBusy] = useState(false)
  const request = useRef(0), mounted = useRef(true), expanded = useRef(false)
  const load = async (details = expanded.current) => {
    const n = ++request.current
    setLoading(true)
    try {
      const result: State = await api.godotState(taskId, details)
      if (!mounted.current || n !== request.current) return
      setState(result); setError('')
    } catch (e) { if (mounted.current && n === request.current) { setState(previous => previous ? { ...previous, project: null } : null); setPrepared(null); setError(errText(e)) } }
    finally { if (mounted.current && n === request.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true
    setState(null); setPrepared(null); setProbe(null)
    void load()
    const off = onChat(e => { if (e.groupsChanged || e.worktreesChanged === game) { setPrepared(null); setProbe(null); void load() } })
    return () => { mounted.current = false; ++request.current; off() }
  }, [taskId, game])
  useEffect(() => { setPrepared(null) }, [action, script, scene, preset, output, log, debug, headless])
  const perform = async (f: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await f() } catch (e) { if (mounted.current) setError(errText(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  if (!state?.organizer?.config.enabled || (!state.available && !state.error)) return null
  const project = state.project, active = runs.some(r => r.status === 'running'), blocked = busy || loading || disabled || active
  const presets = project?.presets.filter(p => p.platform === 'Windows Desktop' && p.embeddedPck) ?? []
  const ready = !!project?.supported && (action !== 'check' || !!script.trim()) && (action !== 'export' || !!preset && !!output.trim())
  const godotRuns = runs.filter(r => /^Godot · /.test(r.name))
  const currentCommand = prepared && commands.find(c => c.name === prepared.name)
  const unchanged = !!currentCommand && currentCommand.program === prepared?.program && currentCommand.purpose === prepared?.purpose && JSON.stringify(currentCommand.args) === JSON.stringify(prepared?.args)
  return <details className="workflow godot-panel" name="task-tools" onToggle={e => { expanded.current = e.currentTarget.open; setOpen(expanded.current); if (expanded.current) void load(true) }}>
    <summary>Godot local <span>{state.organizer.name}</span></summary>
    {open && <div className="workflow-body">
      <div className="godot-head"><p className="muted">Na pasta desta tarefa, incluindo worktree.</p><button className="text-btn" disabled={busy || loading} onClick={() => { setPrepared(null); setProbe(null); void load() }}>{loading ? 'Atualizando…' : 'Atualizar projeto'}</button></div>
      {state.error && <p role="alert" className="err">{state.error}</p>}
      {loading && <p role="status" className="muted">Consultando projeto…</p>}
      {project && <>
        <dl className="godot-facts"><div><dt>Projeto</dt><dd>{project.version || 'Versão não informada'} · {project.language}</dd></div><div><dt>Cena principal</dt><dd><code>{project.mainScene || 'Não configurada'}</code></dd></div></dl>
        {project.warnings.map((warning, i) => <p className="muted" key={i}>{warning}</p>)}
        <div><button disabled={busy || loading || disabled || active} onClick={() => perform(async () => { const n = request.current, result: Probe = await api.godotProbe(taskId); if (mounted.current && n === request.current) setProbe(result) })}>Verificar instalação Godot</button>{probe && <p role="status"><b>{probe.version}</b><small>{probe.executable}</small></p>}</div>
        <form onSubmit={e => { e.preventDefault(); if (ready) void perform(async () => { const n = request.current, command: ProjectCommand = await api.prepareGodotCommand(taskId, action, { ...(script.trim() && action === 'check' ? { script: script.trim() } : {}), ...(action === 'run' ? { headless, ...(scene.trim() ? { scene: scene.trim() } : {}) } : {}), ...(action === 'export' ? { preset, output: output.trim(), debug } : {}), ...(log.trim() ? { log: log.trim() } : {}) }); if (mounted.current && n === request.current) { setPrepared(command); onPrepared(command) } }) }}>
          <label>Ação local<select aria-label="Ação Godot" value={action} disabled={busy} onChange={e => setAction(e.target.value as GodotAction)}>{Object.entries(actionLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
          {action === 'check' && <label>Script relativo ao projeto<input aria-label="Script GDScript a verificar" required value={script} disabled={busy} maxLength={2000} placeholder="scripts/player.gd" onChange={e => setScript(e.target.value)} /><small>Verifica o script escolhido; importação e gameplay são verificações separadas.</small></label>}
          {action === 'run' && <><label>Cena relativa ao projeto (opcional)<input aria-label="Cena Godot a executar" value={scene} disabled={busy} maxLength={2000} placeholder="Vazio executa a cena principal" onChange={e => setScene(e.target.value)} /></label><label className="godot-check"><input aria-label="Godot sem janela" type="checkbox" checked={headless} disabled={busy} onChange={e => setHeadless(e.target.checked)} />Executar sem janela (headless)</label></>}
          {action === 'export' && <>
            <label>Preset de exportação<select aria-label="Preset Godot de exportação" required value={preset} disabled={busy} onChange={e => { setPreset(e.target.value); setOutput(presets.find(p => p.name === e.target.value)?.output || '') }}><option value="">Escolha um preset</option>{presets.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}</select></label>
            {!presets.length && <p className="muted">Configure um preset Windows Desktop com PCK embutido no editor Godot.</p>}
            <label>Novo arquivo relativo ao projeto<input aria-label="Saída Godot de exportação" required value={output} disabled={busy} maxLength={2000} placeholder="builds/jogo.exe" onChange={e => setOutput(e.target.value)} /><small>O executável terá o PCK embutido. Use um destino novo para preservar builds anteriores.</small></label>
            <label>Modo<select aria-label="Modo da exportação Godot" value={debug ? 'debug' : 'release'} disabled={busy} onChange={e => setDebug(e.target.value === 'debug')}><option value="release">Release</option><option value="debug">Debug</option></select></label>
          </>}
          <details><summary>Arquivo de log (opcional)</summary><label>Caminho relativo ao projeto<input aria-label="Arquivo de log Godot" value={log} disabled={busy} maxLength={2000} placeholder="logs/godot.log" onChange={e => setLog(e.target.value)} /></label><small>Somente se quiser consultar este log com as ferramentas Godot. O histórico do comando continua disponível no dashboard.</small></details>
          <button disabled={blocked || !ready}>Preparar comando para revisão</button>
        </form>
        {prepared && <div className="godot-preview" aria-label="Comando Godot preparado"><b>{prepared.name}</b><code>{prepared.program} {JSON.stringify(prepared.args)}</code><small>{unchanged ? 'Preparado; execute quando os argumentos estiverem corretos.' : 'O comando foi alterado. Prepare novamente antes de executar.'}</small><div className="step-actions"><button className="primary" disabled={blocked || !unchanged} onClick={() => perform(async () => { await api.runProjectCommand(taskId, prepared.name) })}>Executar comando Godot</button><button className="text-btn" disabled={busy} onClick={() => setPrepared(null)}>Fechar prévia</button></div></div>}
        {!!godotRuns.length && <div className="godot-runs">{godotRuns.map(run => <GodotRun key={run.id} taskId={taskId} run={run} />)}</div>}
        <p className="muted">Depois de exportar, registre a execução abaixo e revise em Produção → Builds. Vincule a build ao Playtest. Após a revisão humana, integre a worktree no painel de branches.</p>
      </>}
      {error && <p className="err" role="alert">{error}</p>}
    </div>}
  </details>
}

function GodotRun({ taskId, run }: { taskId: number; run: CommandRunSummary }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [register, setRegister] = useState(false), [title, setTitle] = useState(''), [version, setVersion] = useState(''), [notes, setNotes] = useState(''), [buildId, setBuildId] = useState<number | null>(null)
  const request = useRef(0)
  useEffect(() => {
    const invalidate=()=>{++request.current;setDiagnostics(null)}
    invalidate()
    const off=onChat(e=>{if(e.taskId===taskId&&e.commandOutput?.id===run.id)invalidate()})
    return()=>{++request.current;off()}
  }, [taskId, run.id, run.status, run.truncated])
  return <details className="godot-run"><summary>#{run.id} {run.name} · {statusText[run.status]} · exit {run.exit_code ?? '—'}</summary><div className="godot-run-body">
    <small>{run.workspace}</small>
    <div className="step-actions"><button disabled={busy} onClick={async () => { const n = request.current; setBusy(true); setError(''); try { const result: Diagnostics = await api.godotDiagnostics(taskId, run.id); if (n === request.current) setDiagnostics(result) } catch (e) { if (n === request.current) setError(errText(e)) } finally { setBusy(false) } }}>{busy ? 'Consultando…' : 'Consultar diagnóstico'}</button>{run.status === 'running' && <button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await api.cancelProjectCommand(taskId, run.id) } catch (e) { setError(errText(e)) } finally { setBusy(false) } }}>Cancelar Godot</button>}</div>
    {diagnostics && <div role="status"><p>{diagnostics.errorCount} erro(s) · {diagnostics.warningCount} aviso(s)</p><ul className="godot-diagnostics">{diagnostics.items.map((item, i) => <li key={i} className={item.severity}><p>{item.message}{item.count > 1 && ` (${item.count} ocorrências)`}</p>{item.file && <code>{item.file}{item.line != null && `:${item.line}`}</code>}</li>)}</ul>{!diagnostics.items.length && <p className="muted">Nenhum diagnóstico reconhecido. Confira os logs completos e o resultado esperado; exit 0 não comprova gameplay.</p>}{!!diagnostics.run.truncated && <p className="muted">A saída registrada foi cortada. Este diagnóstico cobre somente a parte disponível.</p>}</div>}
    <p className="muted">Logs completos em Comandos do projeto → Histórico desta tarefa.</p>
    {run.name === 'Godot · Exportar build' && run.status === 'completed' && !buildId && <button disabled={busy} onClick={() => setRegister(!register)}>Registrar build desta exportação</button>}
    {register && !buildId && <form className="godot-register" onSubmit={async e => { e.preventDefault(); const n = request.current; setBusy(true); setError(''); try { const result: { id: number } = await api.registerGodotBuild(taskId, run.id, { title: title.trim(), version: version.trim(), notes: notes.trim() }); if (n === request.current) { setBuildId(result.id); setRegister(false) } } catch (e) { if (n === request.current) setError(errText(e)) } finally { setBusy(false) } }}>
      <label>Nome da build<input aria-label={`Nome da build Godot ${run.id}`} required value={title} disabled={busy} maxLength={160} onChange={e => setTitle(e.target.value)} /></label>
      <label>Versão<input aria-label={`Versão da build Godot ${run.id}`} required value={version} disabled={busy} maxLength={80} placeholder="0.1" onChange={e => setVersion(e.target.value)} /></label>
      <label>Notas (opcional)<textarea aria-label={`Notas da build Godot ${run.id}`} value={notes} disabled={busy} maxLength={12000} rows={2} onChange={e => setNotes(e.target.value)} /></label>
      <p className="muted">Captura o executável desta exportação como snapshot pendente. Registro não aprova qualidade nem inicia IA.</p>
      <button disabled={busy || !title.trim() || !version.trim()}>Registrar snapshot da build</button>
    </form>}
    {buildId && <p role="status">Build #{buildId} registrada, aguardando revisão em Produção → Builds.</p>}
    {error && <p className="err" role="alert">{error}</p>}
  </div></details>
}

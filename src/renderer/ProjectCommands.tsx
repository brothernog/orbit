import { useEffect, useState } from 'react'
import { api, errText, onChat } from './api'
import type { ProjectCommand, CommandRun } from '../main/commands'
import './workflow.css'
const labels: Record<string,string>={test:'Teste',build:'Build',run:'Jogo',running:'Executando',completed:'Concluído',failed:'Falhou',cancelled:'Cancelado'}
export function ProjectCommands({taskId,game,disabled}:{taskId:number;game:string;disabled:boolean}) {
  const [commands,setCommands]=useState<ProjectCommand[]>([]),[runs,setRuns]=useState<CommandRun[]>([]),[error,setError]=useState(''),[saving,setSaving]=useState(false)
  const [editing,setEditing]=useState(false),[name,setName]=useState(''),[program,setProgram]=useState(''),[args,setArgs]=useState('[]'),[purpose,setPurpose]=useState<ProjectCommand['purpose']>('test')
  useEffect(()=>{let live=true;const load=()=>Promise.all([api.projectCommands(game),api.listCommandRuns(taskId)]).then(([c,r])=>{if(live){setCommands(c);setRuns(r)}},e=>live&&setError(errText(e)));load();const off=onChat(e=>{if(e.commandChanged&&(e.taskId===taskId||!e.taskId))load()});return()=>{live=false;off()}},[game,taskId])
  const action=async(f:()=>Promise<unknown>)=>{setSaving(true);setError('');try{await f();setCommands(await api.projectCommands(game));setRuns(await api.listCommandRuns(taskId))}catch(e){setError(errText(e))}finally{setSaving(false)}}
  const preset=(kind:'test'|'run')=>{setEditing(true);setName(kind==='test'?'Validar Godot':'Executar Godot');setProgram('godot');setPurpose(kind);setArgs(JSON.stringify(kind==='test'?['--headless','--path','.','--editor','--quit']:['--path','.']))}
  const active=runs.some(r=>r.status==='running')
  return <details className="workflow project-commands" name="task-tools"><summary>Comandos do projeto <span>{active?'Executando':commands.length}</span></summary><div className="workflow-body">
    <p className="muted">Executa na pasta desta tarefa (incluindo worktree). Revise o programa e os argumentos antes de executar.</p>
    <ul className="command-list">{commands.map(c=><li key={c.name}><div><b>{c.name}</b><span>{labels[c.purpose]}</span></div><code>{c.program} {JSON.stringify(c.args)}</code><div className="step-actions"><button className="primary" disabled={disabled||saving||active} onClick={()=>action(()=>api.runProjectCommand(taskId,c.name))}>Executar</button><button className="text-btn" disabled={saving} onClick={()=>{setName(c.name);setProgram(c.program);setArgs(JSON.stringify(c.args));setPurpose(c.purpose);setEditing(true)}}>Editar</button><button className="text-btn" disabled={saving||active} onClick={()=>action(()=>api.saveProjectCommands(game,commands.filter(x=>x.name!==c.name)))}>Remover</button></div></li>)}</ul>
    <div className="step-actions"><button className="text-btn" onClick={()=>{setEditing(!editing);setName('');setProgram('');setArgs('[]')}}>Configurar comando</button><button className="text-btn" onClick={()=>preset('test')}>Preset validar Godot</button><button className="text-btn" onClick={()=>preset('run')}>Preset executar Godot</button></div>
    {editing&&<form onSubmit={e=>{e.preventDefault();action(async()=>{const cmd={name,program,args:JSON.parse(args),purpose};await api.saveProjectCommands(game,[...commands.filter(c=>c.name!==name),cmd]);setEditing(false)})}}>
      <input aria-label="Nome do comando" placeholder="Nome do comando" value={name} maxLength={100} onChange={e=>setName(e.target.value)}/>
      <select aria-label="Finalidade" value={purpose} onChange={e=>setPurpose(e.target.value as ProjectCommand['purpose'])}><option value="test">Teste</option><option value="build">Build</option><option value="run">Executar jogo</option></select>
      <input aria-label="Programa" placeholder="Executável: godot, node ou caminho de .exe" value={program} maxLength={2000} onChange={e=>setProgram(e.target.value)}/>
      <textarea aria-label="Argumentos JSON" value={args} rows={2} onChange={e=>setArgs(e.target.value)}/>
      <small className="muted">Argumentos em array JSON, por exemplo ["--headless","--path","."]. Sem shell ou .cmd/.bat. Para npm use node + npm-cli.js.</small>
      <button className="primary" disabled={saving||!name.trim()||!program.trim()}>Salvar comando</button>
    </form>}
    {!!runs.length&&<details><summary>Histórico desta tarefa ({runs.length})</summary>{runs.map(r=><details key={r.id} className="command-result"><summary>#{r.id} {r.name} · {labels[r.status]} · exit {r.exit_code??'—'}{r.duration_ms!=null&&` · ${(r.duration_ms/1000).toFixed(1)}s`}</summary><small>{r.workspace}</small>{r.status==='running'&&<button className="text-btn" onClick={()=>action(()=>api.cancelProjectCommand(taskId,r.id))}>Cancelar comando</button>}{r.error&&<p className="err">{r.error}</p>}<pre>{r.output||'Sem saída registrada.'}</pre>{!!r.truncated&&<p className="muted">Saída cortada após 1.000.000 caracteres.</p>}</details>)}</details>}
    {error&&<p role="alert" className="err">{error}</p>}
  </div></details>
}

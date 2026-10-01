import { useEffect, useRef, useState } from 'react'
import { api, errText, onChat } from './api'
import type { ProjectCommand, CommandRunSummary } from '../main/commands'
import { GodotPanel } from './GodotPanel'
import { BlenderPanel } from './BlenderPanel'
import { UnityPanel } from './UnityPanel'
import './workflow.css'
const labels: Record<string,string>={test:'Teste',build:'Build',run:'Jogo',running:'Executando',completed:'Concluído',failed:'Falhou',cancelled:'Cancelado'}
export function ProjectCommands({taskId,game,disabled}:{taskId:number;game:string;disabled:boolean}) {
  const [commands,setCommands]=useState<ProjectCommand[]>([]),[runs,setRuns]=useState<CommandRunSummary[]>([]),[error,setError]=useState(''),[saving,setSaving]=useState(false),[open,setOpen]=useState(false)
  const [editing,setEditing]=useState(false),[name,setName]=useState(''),[program,setProgram]=useState(''),[args,setArgs]=useState('[]'),[purpose,setPurpose]=useState<ProjectCommand['purpose']>('test')
  const configRequest=useRef(0)
  useEffect(()=>{
    let live=true, initial=true
    const received=new Map<number,CommandRunSummary>()
    const merge=(rows:CommandRunSummary[],updated:Iterable<CommandRunSummary>)=>Array.from(new Map([...rows,...updated].map(r=>[r.id,r])).values()).sort((a,b)=>b.id-a.id).slice(0,20)
    const loadCommands=async()=>{const n=++configRequest.current;try{const result=await api.projectCommands(game);if(live&&n===configRequest.current)setCommands(result)}catch(e){if(live&&n===configRequest.current)setError(errText(e))}}
    void loadCommands()
    api.listCommandRuns(taskId).then((rows:CommandRunSummary[])=>{if(live)setRuns(merge(rows,received.values()))},e=>live&&setError(errText(e))).finally(()=>{initial=false;received.clear()})
    const off=onChat(e=>{
      if(e.commandConfigChanged&&e.game?.toLowerCase()===game.toLowerCase())void loadCommands()
      if(e.commandChanged&&e.taskId===taskId&&e.commandRun){const run:CommandRunSummary=e.commandRun;if(initial)received.set(run.id,run);setRuns(rows=>merge(rows,[run]))}
    })
    return()=>{live=false;++configRequest.current;off()}
  },[game,taskId])
  const action=async(f:()=>Promise<unknown>)=>{setSaving(true);setError('');try{await f()}catch(e){setError(errText(e))}finally{setSaving(false)}}
  const save=async(next:ProjectCommand[])=>{const saved:ProjectCommand[]=await api.saveProjectCommands(game,next);++configRequest.current;setCommands(saved)}
  const active=runs.some(r=>r.status==='running')
  // Unity/Blender: o painel so avisa que preparou; relê a configuração (a mesma leitura que o evento de configuração faz).
  const reloadCommands=async()=>{const n=++configRequest.current;const result=await api.projectCommands(game);if(n===configRequest.current)setCommands(result)}
  return <><GodotPanel taskId={taskId} game={game} disabled={disabled} commands={commands} runs={runs} onPrepared={command=>{++configRequest.current;setCommands(rows=>[...rows.filter(c=>c.name!==command.name),command])}}/><BlenderPanel taskId={taskId} game={game} disabled={disabled} commands={commands} runs={runs} onPrepared={reloadCommands}/><UnityPanel taskId={taskId} game={game} disabled={disabled} commands={commands} runs={runs} onPrepared={reloadCommands}/><details className="workflow project-commands" name="task-tools" onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open)}}><summary>{active&&<i className="att" data-att="working"/>}Comandos do projeto {(active||!!commands.length)&&<span>{active?'Executando':commands.length}</span>}</summary><div className="workflow-body">
    <p className="muted">Executa na pasta desta tarefa (incluindo worktree). Revise o programa e os argumentos antes de executar.</p>
    <ul className="command-list">{commands.map(c=><li key={c.name}><div><b>{c.name}</b><span>{labels[c.purpose]}</span></div><code>{c.program} {JSON.stringify(c.args)}</code><div className="step-actions"><button className="primary" disabled={disabled||saving||active} onClick={()=>action(()=>api.runProjectCommand(taskId,c.name))}>Executar</button><button className="text-btn" disabled={saving} onClick={()=>{setName(c.name);setProgram(c.program);setArgs(JSON.stringify(c.args));setPurpose(c.purpose);setEditing(true)}}>Editar</button><button className="text-btn" disabled={saving||active} onClick={()=>action(()=>save(commands.filter(x=>x.name!==c.name)))}>Remover</button></div></li>)}</ul>
    <div className="step-actions"><button className="text-btn" onClick={()=>{setEditing(!editing);setName('');setProgram('');setArgs('[]')}}>Configurar comando</button></div>
    {editing&&<form onSubmit={e=>{e.preventDefault();action(async()=>{const cmd={name,program,args:JSON.parse(args),purpose};await save([...commands.filter(c=>c.name!==name),cmd]);setEditing(false)})}}>
      <input aria-label="Nome do comando" placeholder="Nome do comando" value={name} maxLength={100} onChange={e=>setName(e.target.value)}/>
      <select aria-label="Finalidade" value={purpose} onChange={e=>setPurpose(e.target.value as ProjectCommand['purpose'])}><option value="test">Teste</option><option value="build">Build</option><option value="run">Executar jogo</option></select>
      <input aria-label="Programa" placeholder="Executável: godot, node ou caminho de .exe" value={program} maxLength={2000} onChange={e=>setProgram(e.target.value)}/>
      <textarea aria-label="Argumentos JSON" value={args} rows={2} onChange={e=>setArgs(e.target.value)}/>
      <small className="muted">Argumentos em array JSON, por exemplo ["--headless","--path","."]. Sem shell ou .cmd/.bat. Para npm use node + npm-cli.js.</small>
      <button className="primary" disabled={saving||!name.trim()||!program.trim()}>Salvar comando</button>
    </form>}
    {open&&!!runs.length&&<CommandHistory taskId={taskId} runs={runs} cancel={id=>action(()=>api.cancelProjectCommand(taskId,id))}/>}
    {open&&<WorktreeCopy game={game}/>}
    {error&&<p role="alert" className="err">{error}</p>}
  </div></details></>
}
function CommandHistory({taskId,runs,cancel}:{taskId:number;runs:CommandRunSummary[];cancel:(id:number)=>void}) {
  const [open,setOpen]=useState(false)
  return <details onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open)}}><summary>Histórico desta tarefa ({runs.length})</summary>{open&&runs.map(run=><CommandResult key={run.id} taskId={taskId} run={run} cancel={()=>cancel(run.id)}/>)}</details>
}
function CommandResult({taskId,run,cancel}:{taskId:number;run:CommandRunSummary;cancel:()=>void}) {
  const [open,setOpen]=useState(false)
  return <details className="command-result" onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open)}}><summary>#{run.id} {run.name} · {labels[run.status]} · exit {run.exit_code??'—'}{run.duration_ms!=null&&` · ${(run.duration_ms/1000).toFixed(1)}s`}</summary>{open&&<><small>{run.workspace}</small>{run.status==='running'&&<button className="text-btn" onClick={cancel}>Cancelar comando</button>}{run.error&&<p className="err">{run.error}</p>}<CommandLog taskId={taskId} run={run}/></>}</details>
}
function CommandLog({taskId,run}:{taskId:number;run:CommandRunSummary}) {
  const [output,setOutput]=useState<string|null>(null),[truncated,setTruncated]=useState(false),[error,setError]=useState('')
  const retry=useRef<()=>void>(()=>{})
  useEffect(()=>{
    let live=true, pending=false, failed=false, text='', desired=0
    const read=async()=>{
      if(!live||pending||failed)return
      pending=true
      try {
        const result:{offset:number;output:string;total:number;truncated:number}=await api.commandOutput(taskId,run.id,text.length)
        if(!live)return
        if(result.offset!==text.length)throw Error('A saída do comando mudou. Reabra o histórico para consultar novamente.')
        text+=result.output;desired=Math.max(desired,result.total)
        setOutput(text);setTruncated(value=>value||!!result.truncated);setError('')
      }catch(e){if(live){failed=true;setError(errText(e))}}
      finally{pending=false;if(live&&!failed&&desired>text.length)void read()}
    }
    retry.current=()=>{failed=false;void read()}
    const off=onChat(e=>{if(e.taskId===taskId&&e.commandOutput?.id===run.id){desired=Math.max(desired,e.commandOutput.outputLength);setTruncated(value=>value||!!e.commandOutput.truncated);if(desired>text.length)void read()}})
    void read()
    return()=>{live=false;off();retry.current=()=>{}}
  },[taskId,run.id])
  return <>{error&&<p role="alert" className="err">{error} <button className="text-btn" onClick={()=>retry.current()}>Tentar novamente</button></p>}{output===null?!error&&<p className="muted" role="status">Consultando saída…</p>:<pre>{output||'Sem saída registrada.'}</pre>}{(truncated||!!run.truncated)&&<p className="muted">Saída cortada após 1.000.000 caracteres.</p>}</>
}
// Ao isolar em worktree: o que copiar da pasta do projeto (o git nao leva arquivos ignorados, como .env ou o cache .godot/).
function WorktreeCopy({game}:{game:string}) {
  const [list,setList]=useState<string[]|null>(null),[sug,setSug]=useState<string[]>([]),[add,setAdd]=useState(''),[error,setError]=useState('')
  useEffect(()=>{api.worktreeCopy(game).then((r:{list:string[];suggestions:string[]})=>{setList(r.list);setSug(r.suggestions)},e=>setError(errText(e)))},[game])
  if(!list)return null
  const save=(next:string[])=>{setError('');api.saveWorktreeCopy(game,next).then(setList,e=>setError(errText(e)))}
  const has=(p:string)=>list.some(x=>x.toLowerCase()===p.toLowerCase())
  const all=[...list,...sug.filter(s=>!has(s))]
  return <details className="wt-copy"><summary>Ao isolar em worktree, copiar <span>{list.length||'nada'}</span></summary>
    <p className="muted">O Git não leva arquivos ignorados para a worktree. Marque o que copiar da pasta do projeto; o que a worktree já tem não é sobrescrito.</p>
    {all.length?<div className="wt-chips">{all.map(p=><label key={p} className={`wt-chip ${has(p)?'on':''}`}><input type="checkbox" checked={has(p)} onChange={()=>save(has(p)?list.filter(x=>x.toLowerCase()!==p.toLowerCase()):[...list,p])}/>{p}</label>)}</div>
      :<p className="muted">Nenhum arquivo ignorado pelo Git na pasta do projeto.</p>}
    <form className="wt-add" onSubmit={e=>{e.preventDefault();if(add.trim()){save([...list,add.trim()]);setAdd('')}}}>
      <input aria-label="Outro caminho para copiar" placeholder="Outro caminho, ex.: config/local.json" value={add} maxLength={260} onChange={e=>setAdd(e.target.value)}/>
      <button className="text-btn" disabled={!add.trim()}>Adicionar</button>
    </form>
    {error&&<p role="alert" className="err">{error}</p>}
  </details>
}

import { useEffect, useState } from 'react'
import { api, errText, onChat } from './api'
import type { Step } from '../main/workflows'
import './workflow.css'
const LABEL: Record<string,string> = { pending:'Pendente',starting:'Preparando',awaiting_context:'Aguardando contexto',running:'Executando',review:'Revisar resultado',accepted:'Aceita',failed:'Falhou',cancelled:'Cancelada' }
export function Workflow({ taskId, disabled, onPrepare }: { taskId: number; disabled: boolean; onPrepare: (step: Step) => void }) {
  const [steps,setSteps]=useState<Step[]>([]), [error,setError]=useState(''), [title,setTitle]=useState(''), [instruction,setInstruction]=useState(''), [busy,setBusy]=useState(false)
  useEffect(() => { let live=true; const load=()=>api.listSteps(taskId).then(s=>live&&setSteps(s),e=>live&&setError(errText(e))); load(); const off=onChat(e=>{if(e.done||e.refresh) load()}); return()=>{live=false;off()} },[taskId])
  const action=async(f:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await f();setSteps(await api.listSteps(taskId))}catch(e){setError(errText(e))}finally{setBusy(false)}}
  return <details className="workflow" name="task-tools"><summary>{steps.some(s=>s.state==='review')?<i className="att" data-att="wait" title="Etapa aguardando o seu aceite"/>:steps.some(s=>['starting','running'].includes(s.state))&&<i className="att" data-att="working"/>}Etapas de trabalho {!!steps.length&&<span>{steps.filter(s=>s.state==='accepted').length}/{steps.length}</span>}</summary>
    <div className="workflow-body">
      {!steps.length&&<p className="muted">Organize a tarefa em etapas. Cada resultado precisa do seu aceite antes da próxima.</p>}
      <ol>{steps.map((s,i)=>{const ready=steps.slice(0,i).every(p=>p.state==='accepted');return <li key={s.id}>
        <div><b>{s.title}</b><span className={'step-state '+s.state}>{LABEL[s.state]}</span></div>
        <details><summary>Ordem da etapa</summary><p className="step-instruction">{s.instruction}</p>{s.run_id&&<small>Execução #{s.run_id}; resultado no histórico desta conversa.</small>}</details>
        {s.error&&<p role="alert" className="err">{s.error}</p>}
        {['pending','failed','cancelled'].includes(s.state)&&<button className="text-btn" disabled={disabled||busy||!ready} onClick={()=>onPrepare(s)}>Preparar no chat</button>}
        {s.state==='review'&&<span className="step-actions"><button className="primary" disabled={busy} onClick={()=>action(()=>api.reviewStep(s.id,true))}>Aceitar etapa</button><button className="text-btn" disabled={busy} onClick={()=>action(()=>api.reviewStep(s.id,false))}>Pedir correção</button></span>}
      </li>})}</ol>
      <form onSubmit={e=>{e.preventDefault();action(async()=>{await api.addStep(taskId,title,instruction);setTitle('');setInstruction('')})}}>
        <input aria-label="Título da etapa" placeholder="Etapa: investigar, implementar, validar…" value={title} maxLength={200} onChange={e=>setTitle(e.target.value)} />
        <textarea aria-label="Ordem da etapa" placeholder="O que o agente deve fazer e como conferir o resultado" value={instruction} maxLength={20000} rows={2} onChange={e=>setInstruction(e.target.value)} />
        <button className="text-btn" disabled={busy||!title.trim()||!instruction.trim()}>Adicionar etapa</button>
      </form>
      {error&&<p className="err" role="alert">{error}</p>}
    </div>
  </details>
}

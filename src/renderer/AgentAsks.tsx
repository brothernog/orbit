import { useEffect, useState } from 'react'
import { api, errText, onChat } from './api'
import { Icon, PROVIDER } from './icons'
import './permission.css'
import './asks.css'

// O que o agente pai pede ao usuario pelo chat da tarefa, acima do composer (mesmo lugar do pedido de permissao):
// - QuestionPrompt: perguntas de ask_user. O agente esta PARADO esperando; a resposta volta direto para ele.
// - SuggestionChips: tarefas sugeridas por suggest_task. Usar cria uma tarefa nova e so PREENCHE o compositor dela (nada e enviado).
type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }
type Pending = { id: number; taskId: number; provider: string; questions: Question[] }
type Pick = { selected: string[]; other: string }

export function QuestionPrompt({ taskId }: { taskId: number }) {
  const [list, setList] = useState<Pending[]>([])
  const [picks, setPicks] = useState<Pick[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => api.listQuestions(taskId).then(setList, () => {})
  useEffect(() => {
    load()
    const off = onChat(ev => { if (ev?.taskId === taskId && (ev.questionRequest || ev.questionResolved)) load() })
    const t = setInterval(load, 4000) // rede de seguranca se algum evento se perder
    return () => { off(); clearInterval(t) }
  }, [taskId])

  const p = list[0]
  useEffect(() => { setPicks(p ? p.questions.map(() => ({ selected: [], other: '' })) : []); setErr('') }, [p?.id])
  if (!p || picks.length !== p.questions.length) return null

  const who = PROVIDER[p.provider]?.label ?? p.provider
  const set = (i: number, f: (x: Pick) => Pick) => setPicks(ps => ps.map((x, j) => (j === i ? f(x) : x)))
  // Escolha unica: marcar uma opcao descarta o texto livre e vice-versa (uma resposta so). Varias: independentes.
  const toggle = (i: number, q: Question, label: string) => set(i, x => q.multiSelect
    ? { ...x, selected: x.selected.includes(label) ? x.selected.filter(s => s !== label) : [...x.selected, label] }
    : { selected: [label], other: '' })
  const write = (i: number, q: Question, other: string) => set(i, x => ({ selected: q.multiSelect || !other.trim() ? x.selected : [], other }))
  const ready = picks.every(x => x.selected.length || x.other.trim())
  const reply = (answers: Pick[] | null) => {
    setBusy(true); setErr('')
    api.answerQuestion(p.id, answers).then(load, (e: any) => { setErr(errText(e)); load() }).finally(() => setBusy(false))
  }

  return (
    <div className="pp-inline">
      <form className="pp qp" aria-labelledby={`qp-${p.id}`} onSubmit={e => { e.preventDefault(); if (ready) reply(picks) }}
        onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey && ready && !busy) { e.preventDefault(); reply(picks) } }}>
        <h2 id={`qp-${p.id}`}><Icon n="spark" size={16} /> {who} tem {p.questions.length === 1 ? 'uma pergunta' : `${p.questions.length} perguntas`}{list.length > 1 && <small className="pp-count">1 de {list.length}</small>}</h2>
        {p.questions.map((q, i) => (
          <fieldset key={i} className="qp-q">
            <legend><span className="qp-tag">{q.header}</span>{q.question}{q.multiSelect && <small> (marque quantas quiser)</small>}</legend>
            {q.options.map(o => {
              const on = picks[i].selected.includes(o.label)
              return (
                <label key={o.label} className={`qp-opt ${on ? 'on' : ''}`}>
                  <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`qp-${p.id}-${i}`} checked={on} onChange={() => toggle(i, q, o.label)} />
                  <span><b>{o.label}</b>{o.description && <small>{o.description}</small>}</span>
                </label>
              )
            })}
            <input className="qp-other" aria-label={`Outra resposta para ${q.header}`} placeholder="Outra resposta…" maxLength={2000} value={picks[i].other} onChange={e => write(i, q, e.target.value)} />
          </fieldset>
        ))}
        {err && <small className="err" role="alert">{err}</small>}
        <div className="pp-actions">
          <button type="submit" className="primary" disabled={busy || !ready}>Responder</button>
          <button type="button" disabled={busy} onClick={() => reply(null)}>Pular</button>
        </div>
        <small>{who} espera a resposta para continuar. Pular (ou não responder a tempo) faz ele seguir com a suposição mais segura.</small>
      </form>
    </div>
  )
}

type Suggestion = { id: number; title: string; tldr: string; prompt: string }

export function SuggestionChips({ taskId, onStart }: { taskId: number; onStart: (game: string, taskId: number, text: string) => void }) {
  const [list, setList] = useState<Suggestion[]>([])
  const [open, setOpen] = useState<number | null>(null) // ordem completa visivel antes de usar
  const [err, setErr] = useState('')
  const load = () => api.listSuggestions(taskId).then(setList, () => {})
  useEffect(() => {
    load()
    return onChat(ev => { if (ev?.taskId === taskId && (ev.suggestion || ev.done)) load() })
  }, [taskId])
  if (!list.length) return null

  const act = (f: Promise<any>) => { setErr(''); return f.then(r => { load(); return r }, (e: any) => { setErr(errText(e)); load() }) }
  const start = (s: Suggestion) => act(api.startSuggestion(s.id)).then(r => r && onStart(r.game, r.taskId, r.text))
  return (
    <section className="sg" aria-label="Tarefas sugeridas pelo agente">
      {list.map(s => (
        <div key={s.id} className="sg-chip">
          <Icon n="pin" size={14} />
          <div className="sg-text">
            <button type="button" className="sg-title" aria-expanded={open === s.id} title="Ver a ordem completa" onClick={() => setOpen(open === s.id ? null : s.id)}>{s.title}</button>
            <small>{s.tldr}</small>
            {open === s.id && <pre className="sg-prompt">{s.prompt}</pre>}
          </div>
          <button type="button" className="text-btn" title="Cria uma tarefa neste projeto com a ordem no compositor. Nada é enviado até você enviar." onClick={() => start(s)}>Abrir tarefa</button>
          <button type="button" className="icon sm" aria-label={`Dispensar: ${s.title}`} title="Dispensar" onClick={() => act(api.dismissSuggestion(s.id))}><Icon n="close" size={14} /></button>
        </div>
      ))}
      {err && <small className="err" role="alert">{err}</small>}
    </section>
  )
}

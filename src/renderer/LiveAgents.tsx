// Quem trabalha nesta tarefa agora: a ferramenta atual do pai (na linha "trabalhando") e os filhos (delegacoes) desta execucao.
// Foco no que esta ativo: filhos rodando ou esperando voce ficam a vista; os que terminaram recolhem numa linha de resumo.
// ponytail: consulta a cada 2 s so enquanto o agente trabalha; trocar por evento se pesar.
import { useEffect, useState } from 'react'
import { api, onChat } from './api'
import { Avatar, Icon, PROVIDER } from './icons'
import { doingText } from './TaskBrief'
import { elapsedMin } from './time'
import type { TaskAgent } from '../main/agentsLive'

export function useTaskAgents(taskId: number, running: boolean) {
  const [list, setList] = useState<TaskAgent[]>([])
  useEffect(() => {
    if (!running) { setList([]); return }
    let live = true
    const load = () => api.taskAgents(taskId).then(next => { if (live) setList(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)) }, () => {})
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, 2000)
    const off = onChat(ev => { if (ev.taskId === taskId && ev.refresh) load() }) // delegacao comecou/terminou (nota no chat)
    return () => { live = false; clearInterval(t); off() }
  }, [taskId, running])
  return list
}

export const parentDoing = (list: TaskAgent[]) => doingText(list.find(a => a.kind === 'parent')?.doing)

const ACTIVE = new Set(['running', 'awaiting_context_approval'])
const DONE_ICON: Record<string, { n: string; label: string }> = { completed: { n: 'check', label: 'concluída' }, failed: { n: 'alert', label: 'falhou' }, cancelled: { n: 'close', label: 'cancelada' } }
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Row({ a }: { a: TaskAgent }) {
  const waiting = a.status === 'awaiting_context_approval', running = a.status === 'running', done = DONE_ICON[a.status]
  const who = `${PROVIDER[a.provider]?.label ?? a.provider}${a.model ? ` ${a.model}` : ''}`
  const sub = running ? doingText(a.doing) ?? 'começando…' : waiting ? 'aguardando você aprovar o contexto' : a.error ? `${who} · ${a.error}` : who
  return (
    <li className={`la-row s-${a.status}`}>
      <Avatar provider={a.provider} size="sm" live={running} />
      <span className="la-body">
        <span className="la-title" title={a.title}>{a.title}</span>
        <span className="la-sub" title={`${who} · ${a.mode === 'edit' ? 'edição' : 'só leitura'}${a.error ? `
${a.error}` : ''}`}>{sub}</span>
      </span>
      {running && a.startedAt && <span className="la-time">{elapsedMin(a.startedAt)}</span>}
      {waiting && <span className="la-wait">você</span>}
      {done && <span className="la-end" title={a.error ? `${done.label}: ${a.error}` : done.label}><Icon n={done.n} size={14} /></span>}
    </li>
  )
}

export function ChildAgents({ list }: { list: TaskAgent[] }) {
  const kids = list.filter(a => a.kind === 'child')
  const active = kids.filter(a => ACTIVE.has(a.status)), done = kids.filter(a => !ACTIVE.has(a.status))
  const [, tick] = useState(0) // o tempo decorrido anda mesmo quando a lista nao muda
  useEffect(() => { if (!active.length) return; const t = setInterval(() => tick(n => n + 1), 15_000); return () => clearInterval(t) }, [active.length])
  if (!kids.length) return null
  const count = (s: string) => done.filter(a => a.status === s).length
  const parts = [
    { n: count('completed'), text: (n: number) => plural(n, 'concluída', 'concluídas'), bad: false },
    { n: count('failed'), text: (n: number) => `${n} ${n === 1 ? 'falhou' : 'falharam'}`, bad: true },
    { n: count('cancelled'), text: (n: number) => plural(n, 'cancelada', 'canceladas'), bad: false }
  ].filter(p => p.n > 0)
  return (
    <section className="live-agents" aria-label="Delegações desta resposta">
      <header>
        <span>Delegações</span>
        {active.length > 0 && <b>{plural(active.length, 'ativa', 'ativas')}</b>}
      </header>
      {active.length > 0 && <ul>{active.map(a => <Row key={a.id} a={a} />)}</ul>}
      {done.length > 0 && (
        <details className="la-done" open={!active.length && done.length <= 2}>
          <summary>
            <Icon n="chevron" size={12} />
            {parts.map((p, i) => <span key={i} className={p.bad ? 'bad' : ''}>{p.text(p.n)}</span>)}
          </summary>
          <ul>{done.map(a => <Row key={a.id} a={a} />)}</ul>
        </details>
      )}
    </section>
  )
}

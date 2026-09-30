// Coluna de conversas: linha de estado de cada tarefa, resumo ao passar o mouse e "Tambem rodando" (outros projetos).
// O resumo vem do que ja esta gravado (taskBriefs no processo principal): nenhuma chamada a modelo.
import { useEffect, useRef, useState } from 'react'
import { api, name, onChat, type Active, type Task } from './api'
import { Avatar, Icon, PROVIDER } from './icons'
import './taskcol.css'

export type Brief = { id: number; last: 'completed' | 'failed' | 'cancelled' | null; awaiting: boolean; permission: string | null; question: string | null; goal: string | null; result: string | null; next: string | null }

// Recarrega quando a lista de tarefas ou os agentes ativos mudam (fim de execucao, pedido novo).
export function useBriefs(game: string | null, tasks: Task[] | null, active: Active[]) {
  const [map, setMap] = useState(new Map<number, Brief>())
  const key = `${game}|${tasks?.map(t => `${t.id}:${t.updated_at}`).join(',')}|${active.map(a => a.taskId).join(',')}`
  useEffect(() => {
    if (!game) return
    let live = true
    const load = () => api.taskBriefs(game).then((l: Brief[]) => { if (live) setMap(new Map(l.map(b => [b.id, b]))) }, () => {})
    load()
    // pedidos de permissao/contexto nao mudam a lista de tarefas: recarrega pelos eventos deles
    const off = onChat((ev: any) => { if (ev?.permissionRequest || ev?.permissionResolved || ev?.questionRequest || ev?.questionResolved || ev?.contextRequest || ev?.contextResolved) load() })
    return () => { live = false; off() }
  }, [key])
  return map
}

// "editando Chat.tsx", "rodando npm test": a ferramenta atual em palavras. Codex informa o proprio comando como nome.
const VERB: Record<string, string> = { Edit: 'editando', MultiEdit: 'editando', Write: 'escrevendo', NotebookEdit: 'editando', Read: 'lendo', Grep: 'buscando', Glob: 'procurando', Bash: 'rodando', PowerShell: 'rodando', WebFetch: 'abrindo', WebSearch: 'pesquisando' }
export function doingText(d: Active['doing']): string | null {
  if (!d) return null
  const v = VERB[d.tool]
  if (v) return d.detail ? `${v} ${d.detail}` : v
  if (/^mcp__/.test(d.tool)) return 'consultando o dashboard'
  return /\s/.test(d.tool) ? `rodando ${d.tool.slice(0, 50)}` : d.tool // sem espaco = nome de ferramenta; com espaco = comando
}
const since = (ms: number) => { const m = Math.round(ms / 60000); return m < 1 ? 'agora' : m < 90 ? `${m} min` : `${Math.round(m / 60)} h` }

// Uma linha curta: o que a tarefa precisa ou o que aconteceu por ultimo. tone colore so o que pede atencao.
export function statusOf(t: Task, b: Brief | undefined, who: Active | undefined, ago: string): { text: string; tone: '' | 'live' | 'wait' | 'bad' } {
  if (b?.question) return { text: `Responder: ${b.question}`, tone: 'wait' } // agente parado esperando voce: vem antes de "trabalhando"
  if (b?.permission) return { text: `Permitir: ${b.permission}`, tone: 'wait' }
  if (who) return { text: `${PROVIDER[who.provider]?.label ?? who.provider} · ${doingText(who.doing) ?? 'trabalhando'} · ${since(Date.now() - who.startedAt)}`, tone: 'live' }
  if (b?.awaiting) return { text: 'Aprovar o contexto para continuar', tone: 'wait' }
  if (t.state === 'concluida') return { text: `Concluída · ${ago}`, tone: '' }
  if (b?.last === 'failed') return { text: `Falhou · ${ago}`, tone: 'bad' }
  if (b?.last === 'cancelled') return { text: `Interrompida · ${ago}`, tone: '' }
  if (b?.last === 'completed') return { text: `Pronto · ${ago}`, tone: '' }
  return { text: t.messages ? ago : 'Sem mensagens ainda', tone: '' }
}

// Cartao flutuante (fixed: dentro da lista rolavel seria cortado). So aparece se houver algo a dizer.
export function useBriefCard(briefs: Map<number, Brief>) {
  const [card, setCard] = useState<{ b: Brief; x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const show = (e: { currentTarget: HTMLElement }, id: number) => {
    const b = briefs.get(id), r = e.currentTarget.getBoundingClientRect()
    clearTimeout(timer.current)
    if (!b || !(b.goal || b.result || b.next)) { setCard(null); return }
    timer.current = setTimeout(() => setCard({ b, x: r.right + 8, y: r.top }), 350) // atraso: passar o mouse pela lista nao pisca cartoes
  }
  const hide = () => { clearTimeout(timer.current); setCard(null) }
  const view = card && (
    <div className="brief-card" role="tooltip" style={{ left: card.x, top: Math.min(card.y, window.innerHeight - 160) }}>
      {card.b.goal && <p><Icon n="target" size={14} /><span>{card.b.goal}</span></p>}
      {card.b.result && <p className="ok"><Icon n="check" size={14} /><span>{card.b.result}</span></p>}
      {card.b.next && <p className="next"><Icon n="arrow" size={14} /><span>{card.b.next}</span></p>}
    </div>
  )
  return { show, hide, view }
}

// Agentes trabalhando em OUTROS projetos: um clique leva a conversa.
export function AlsoRunning({ active, game, onOpen }: { active: Active[]; game: string; onOpen: (a: Active) => void }) {
  const others = active.filter(a => a.game.toLowerCase() !== game.toLowerCase())
  if (!others.length) return null
  return (
    <div className="also-running">
      <div className="chats-group">Também rodando</div>
      {others.map(a => (
        <button key={`${a.kind}${a.id}`} className="task also" onClick={() => onOpen(a)} title={`${name(a.game)}: ${a.title}`}>
          <Avatar provider={a.provider} live size="sm" />
          <span className="task-text"><span className="task-title">{name(a.game)} · {a.title}</span>
            <span className="task-sub">{PROVIDER[a.provider]?.label ?? a.provider} · {since(Date.now() - a.startedAt)}</span></span>
        </button>
      ))}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { onChat } from './api'
import { NoticeCard, NoticeGroup, type Notice } from './NoticeCard'
import { groupNotices } from './noticeGroups'

const MAX = 3

// Cartoes de aviso dentro do app (canto superior direito). So "terminou" some sozinho; falha, pausa, revisao e aprovacao ficam ate
// voce abrir ou fechar. Pedido de permissao nao vira cartao: o pop-up global ja aparece. A tarefa aberta na tela nao gera cartao.
// Com o app fora de foco quem avisa e o planeta do canto da tela (Planet.tsx); o que ninguem abriu la chega aqui ao voltar.
export function Toasts({ openTaskId, onOpen }: { openTaskId?: number; onOpen: (game: string, taskId: number, files: boolean) => void }) {
  const [items, setItems] = useState<Notice[]>([])
  const [away, setAway] = useState(!document.hasFocus())
  const drop = (f: (x: Notice) => boolean) => setItems(l => l.filter(x => !f(x)))

  useEffect(() => {
    const on = () => setAway(false), off = () => setAway(true)
    window.addEventListener('focus', on); window.addEventListener('blur', off)
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off) }
  }, [])
  useEffect(() => onChat(ev => {
    const n: Notice | undefined = ev?.attention
    if (n && n.kind !== 'permission' && !(n.taskId === openTaskId && document.hasFocus()))
      setItems(l => [n, ...l.filter(x => x.taskId !== n.taskId || !x.command !== !n.command || x.taskId < 0)]) // um aviso do agente e um de comando por tarefa: o mais novo vale
    if (ev?.contextResolved) drop(x => x.ref?.context === ev.contextResolved)
    if (ev?.openTask?.taskId > 0) onOpen(ev.openTask.game, ev.openTask.taskId, !!ev.openTask.files) // clique na janela de aviso
  }), [openTaskId, onOpen])
  useEffect(() => { if (openTaskId != null) drop(x => x.taskId === openTaskId) }, [openTaskId])

  if (!items.length) return null
  const open = (x: Notice, files: boolean) => { drop(y => y.key === x.key); if (x.taskId > 0) onOpen(x.game, x.taskId, files) }
  const groups = groupNotices(items)
  return (
    <section className="toasts" aria-label="Avisos">
      {groups.slice(0, MAX).map(g => g.length === 1
        ? <NoticeCard key={g[0].key} n={g[0]} life={10} hold={away} onOpen={f => open(g[0], f)} onDismiss={() => drop(y => y.key === g[0].key)} />
        : <NoticeGroup key={`g${g[0].key}`} items={g} life={10} hold={away} onOpen={x => open(x, false)} onDismiss={x => drop(y => y.key === x.key)} onDismissAll={() => drop(y => g.includes(y))} />)}
      {groups.length > MAX && (
        <div className="nc-overflow">
          <span>Mais {groups.length - MAX} {groups.length - MAX === 1 ? 'projeto' : 'projetos'} com avisos</span>
          <button className="text-btn" onClick={() => setItems([])}>Limpar todos</button>
        </div>
      )}
    </section>
  )
}

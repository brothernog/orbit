import { useEffect, useRef, useState } from 'react'
import { api, errText, type Account } from './api'
import { Icon } from './icons'
import { Bar } from './Settings'

type W = { utilization: number; resets_at: string } | null
type Row = { fiveHour?: W; sevenDay?: W; cached?: boolean; error?: string; seenAt?: string | null; expired?: boolean } | null | undefined

const since = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 2 ? 'agora' : m < 90 ? `há ${m} min` : m < 2160 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} d`
}

// Limites de 5 h e semanal de todas as contas, sob demanda: so consulta ao abrir (o endpoint do Claude recusa excesso).
// Nao e foco de tela nenhuma; fica num botao discreto da barra de cima.
export function Limits({ accounts }: { accounts: Account[] }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Record<string, Row>>({})
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    for (const a of accounts) api.accountUsage(a.id).then(u => setRows(r => ({ ...r, [a.id]: u })), e => setRows(r => ({ ...r, [a.id]: { error: errText(e) } })))
    api.codexUsage().then(u => setRows(r => ({ ...r, codex: u })), e => setRows(r => ({ ...r, codex: { error: errText(e) } })))
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', out)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [open])

  const block = (key: string, title: string, empty: string) => {
    const u = rows[key]
    const note = u === undefined ? 'Lendo…'
      : u === null ? empty
      : u.error ? u.error
      : !u.fiveHour && !u.sevenDay ? (u.expired ? 'As janelas reiniciaram desde o último uso.' : 'Sem dados de limite.')
      : u.seenAt ? `Do último uso do Codex, ${since(u.seenAt)}.`
      : u.cached ? 'Último valor visto (consulta indisponível agora).' : ''
    return (
      <section key={key} className="lim-acc">
        <b>{title}</b>
        {u && !u.error && <><Bar label="5 horas" w={u.fiveHour ?? null} /><Bar label="Semana" w={u.sevenDay ?? null} /></>}
        {note && <small>{note}</small>}
      </section>
    )
  }

  return (
    <div className="limits" ref={ref}>
      <button className={`icon ${open ? 'on' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-label="Limites de uso" title="Limites de uso" onClick={() => setOpen(!open)}>
        <Icon n="gauge" />
      </button>
      {open && (
        <div className="lim-pop" role="dialog" aria-label="Limites de uso">
          {accounts.map(a => block(String(a.id), `Claude, ${a.name}`, 'Sem dados.'))}
          {block('codex', 'Codex', 'Nenhuma sessão do Codex encontrada neste computador.')}
        </div>
      )}
    </div>
  )
}

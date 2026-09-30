import { useEffect, useRef, useState } from 'react'
import { api, errText, type Account } from './api'
import { Icon } from './icons'
import { Bar } from './Settings'
import { useCachedRead } from './useCachedRead'
import { usageNote, type QuotaSnapshot } from './usageText'

function QuotaBlock({ title, empty, u, error, source = 'claude' }: {
  title: string; empty: string; u: QuotaSnapshot | null | undefined; error: unknown; source?: 'claude' | 'codex'
}) {
  const note = u === undefined ? error ? errText(error) : 'Lendo…'
    : u === null ? empty
    : u.error ? u.error
    : !u.fiveHour && !u.sevenDay ? (u.expired ? 'As janelas reiniciaram desde o último uso.' : 'Sem dados de limite.')
    : usageNote(u, source)
  return <section className="lim-acc">
    <b>{title}</b>
    {u && !u.error && <><Bar label="5 horas" w={u.fiveHour ?? null} /><Bar label="Semana" w={u.sevenDay ?? null} /></>}
    {note && <small>{note}</small>}
  </section>
}

function AccountLimits({ account }: { account: Account }) {
  const connecting = account.login?.state === 'connecting'
  const { data, error } = useCachedRead<QuotaSnapshot | null>(connecting ? null : `accountUsage:${account.id}`, () => api.accountUsage(account.id), 30_000)
  return <QuotaBlock title={`Claude, ${account.name}`} empty="Sem dados." u={data} error={connecting ? 'Login em andamento.' : error} />
}

function CodexLimits() {
  const { data, error } = useCachedRead<QuotaSnapshot | null>('codexUsage', () => api.codexUsage(), 5_000)
  return <QuotaBlock title="Codex" empty="Nenhuma sessão do Codex encontrada neste computador." u={data} error={error} source="codex" />
}

// Limites de 5 h e semanal de todas as contas, sob demanda: so consulta ao abrir (o endpoint do Claude recusa excesso).
// Nao e foco de tela nenhuma; fica num botao discreto da barra de cima.
export function Limits({ accounts }: { accounts: Account[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', out)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div className="limits" ref={ref}>
      <button className={`icon ${open ? 'on' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-label="Limites de uso" title="Limites de uso" onClick={() => setOpen(!open)}>
        <Icon n="gauge" />
      </button>
      {open && (
        <div className="lim-pop" role="dialog" aria-label="Limites de uso">
          {accounts.map(a => <AccountLimits key={a.id} account={a} />)}
          <CodexLimits />
        </div>
      )}
    </div>
  )
}

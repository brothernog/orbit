import { useEffect, useState } from 'react'
import { duration, stepLabel, summary, type Steps } from './stepsView'
import { Icon } from './icons'
import './activityLog.css'

// Bloco recolhivel sob a resposta: ao vivo ("Trabalhando 1 min 33 s") e, depois, o resumo gravado na mensagem.
export function ActivityLog({ steps, live }: { steps: Steps; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const [began] = useState(Date.now)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { if (!live) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [live])
  const head = live ? `Criando ${duration(now - began)}` : `${summary(steps)}${steps.ms ? ` · ${duration(steps.ms)}` : ''}`
  const hidden = steps.total - steps.items.length
  return (
    <div className={`activity ${live ? 'live' : ''}`}>
      <button type="button" className="activity-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {live && <span className="typing" aria-hidden><i /><i /><i /></span>}<span>{head}</span><Icon n="down" size={14} />
      </button>
      {open && steps.items.length > 0 && <ul className="activity-list">
        {hidden > 0 && <li className="muted">+{hidden} ações anteriores</li>}
        {steps.items.map((s, i) => {
          const { verb, target } = stepLabel(s)
          return <li key={i} className={s.ok === false ? 'bad' : ''}>
            {verb && <b>{verb}</b>} <code title={target}>{target}</code>
            {(s.added || s.removed) ? <span className="delta"><i className="add">+{s.added ?? 0}</i> <i className="del">−{s.removed ?? 0}</i></span> : null}
            {s.ok === false && <span className="fail">falhou</span>}
          </li>
        })}
      </ul>}
    </div>
  )
}

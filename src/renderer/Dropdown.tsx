import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './icons'

export type Opt = { value: string; label: string; group?: string; hint?: string }

// Primeira letra maiuscula so na exibicao; o valor enviado a CLI nao muda.
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

// Lista suspensa propria (abre para cima, ou para baixo com `down`; largura do conteudo). Com `search`, filtra e, com `custom`, aceita um valor digitado.
export function Dropdown({ value, options, onChange, label, title, disabled, placeholder, search, custom, strong, down }: {
  value: string; options: Opt[]; onChange: (v: string) => void; label: string; title?: string; disabled?: boolean
  placeholder: string; search?: boolean; custom?: boolean; strong?: boolean; down?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const current = options.find(o => o.value === value)

  const needle = q.trim().toLowerCase()
  const shown = needle ? options.filter(o => `${o.label} ${o.value}`.toLowerCase().includes(needle)) : options
  const typed = custom && needle && !options.some(o => o.value.toLowerCase() === needle) ? [{ value: q.trim(), label: `Usar "${q.trim()}"` }] : []
  const items: Opt[] = [...shown, ...typed]

  useEffect(() => {
    if (!open) return
    setQ('')
    setHi(Math.max(0, options.findIndex(o => o.value === value)))
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', out)
    return () => document.removeEventListener('mousedown', out)
  }, [open])
  useEffect(() => { list.current?.querySelector('[data-hi]')?.scrollIntoView({ block: 'nearest' }) }, [hi, open])

  const choose = (v: string) => { setOpen(false); if (v !== value) onChange(v) }
  const key = (e: KeyboardEvent) => {
    if (!open) { if (['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(e.key) && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); setOpen(true) } return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi(i => Math.min(items.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[hi]) choose(items[hi].value) }
    else if (e.key === 'Tab') setOpen(false)
  }

  let lastGroup: string | undefined
  return (
    <div className={`dd ${open ? 'open' : ''} ${down ? 'down' : ''}`} ref={ref} onKeyDown={key}>
      <button type="button" className={`dd-btn ${strong ? 'strong' : ''} ${current || value ? '' : 'placeholder'}`} aria-label={`${label}: ${current?.label ?? (value ? cap(value) : placeholder)}`}
        aria-haspopup="listbox" aria-expanded={open} title={title} disabled={disabled} onClick={() => setOpen(!open)}>
        <span>{current?.label ?? (value ? cap(value) : placeholder)}</span>
        <Icon n="chevron" size={12} />
      </button>
      {open && (
        <div className="dd-menu">
          {search && <input className="dd-search" autoFocus placeholder={custom ? 'Buscar ou digitar' : 'Buscar'} aria-label={`Buscar ${label.toLowerCase()}`}
            value={q} onChange={e => { setQ(e.target.value); setHi(0) }} />}
          <ul role="listbox" aria-label={label} ref={list} tabIndex={-1}>
            {items.map((o, i) => {
              const head = o.group !== lastGroup && o.group ? o.group : null
              lastGroup = o.group
              return [
                head && <li key={`g-${head}`} className="dd-group" role="presentation">{head}</li>,
                <li key={o.value + i} role="option" aria-selected={o.value === value} data-hi={i === hi || undefined}
                  className={`${o.value === value ? 'sel' : ''} ${i === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(i)} onMouseDown={e => e.preventDefault()} onClick={() => choose(o.value)}>
                  <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
                  {o.value === value && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>}
                </li>
              ]
            })}
            {items.length === 0 && <li className="dd-empty" role="presentation">Nada encontrado</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

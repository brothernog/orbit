import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { GROUP_COLORS, initials, SUGGESTED, type EngineConfig, type EngineId, type EngineSettings, type Group } from './groups'
import './godot.css'

// Icone do projeto: o da propria pasta (lido pelo processo principal) ou um padrao geometrico gerado do caminho, sempre igual.
const icons = new Map<string, Promise<string | null>>()
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261)

export function ProjectIcon({ game, size = 34 }: { game: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (!icons.has(game)) icons.set(game, api.projectIcon(game).catch(() => null))
    icons.get(game)!.then(s => live && setSrc(s))
    return () => { live = false }
  }, [game])
  if (src) return <img className="picon" src={src} width={size} height={size} alt="" draggable={false} />
  const h = hash(game), hue = h % 360
  const cells: [number, number][] = []
  for (let i = 0; i < 15; i++) if ((h >>> (i + 8)) & 1) { const x = i % 3, y = Math.floor(i / 3); cells.push([x, y]); if (x < 2) cells.push([4 - x, y]) }
  return (
    <svg className="picon gen" width={size} height={size} viewBox="-1 -1 7 7" style={{ '--h': hue } as CSSProperties} aria-hidden="true">
      <rect x="-1" y="-1" width="7" height="7" rx="1.6" className="picon-bg" />
      {cells.map(([x, y]) => <rect key={`${x}${y}`} x={x + .08} y={y + .08} width=".84" height=".84" rx=".22" className="picon-cell" />)}
    </svg>
  )
}

export type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean; hint?: string }

// Menu de contexto na posicao do clique (botao direito ou "..."). Fecha com Esc, clique fora ou ao escolher.
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLUListElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const b = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], i = b.indexOf(document.activeElement as HTMLButtonElement)
        b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length]?.focus()
      }
    }
    document.addEventListener('mousedown', out)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', key) }
  }, [])
  return (
    <ul className="ctx-menu" role="menu" ref={ref} style={{ left: Math.min(x, innerWidth - 200), top: Math.min(y, innerHeight - items.length * 36 - 12) }}>
      {items.map(it => <li key={it.label} role="none"><button role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled} title={it.hint} onClick={() => { onClose(); it.run() }}>{it.label}</button></li>)}
    </ul>
  )
}

// Campo de renomear no lugar do texto: Enter salva, Esc ou sair sem mudar cancela.
export function RenameInput({ value, label, onDone }: { value: string; label: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value)
  const done = useRef(false) // Esc e o blur seguinte nao podem salvar duas vezes
  const finish = (r: string | null) => { if (!done.current) { done.current = true; onDone(r) } }
  return <input className="rename" aria-label={label} autoFocus value={v} maxLength={200} onFocus={e => e.target.select()} onChange={e => setV(e.target.value)}
    onBlur={() => finish(v.trim() && v.trim() !== value ? v.trim() : null)}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') finish(null) }} />
}

export function Confirm({ title, body, action, tone = 'danger', onConfirm, onClose }: { title: string; body: string; action: string; tone?: 'danger' | 'primary'; onConfirm: () => void; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [])
  // Portal: um ancestral com transform/animacao prenderia o position: fixed dentro dele (modal espremido no painel).
  return createPortal(
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{body}</p>
        <footer>
          <button autoFocus onClick={onClose}>Cancelar</button>
          <button className={tone === 'danger' ? 'primary danger' : 'primary'} onClick={() => { onClose(); onConfirm() }}>{action}</button>
        </footer>
      </div>
    </div>, document.body)
}

// Criar ou editar um grupo do trilho: previa ao vivo, sugestoes de um clique e cor. Enter salva.
// Integrações por organizador: ferramentas sob demanda só para agentes invocados nos projetos daquela engine.
const ENGINE_UI: { id: EngineId; label: string; hint: string; exe: string; placeholder: string; note: string }[] = [
  { id: 'godot', label: 'Godot', hint: 'Ferramentas sob demanda para agentes invocados nos projetos Godot deste organizador.', exe: 'Executável Godot 4', placeholder: 'Vazio usa godot no PATH', note: 'Caminho de executável direto. Salvar não inicia a engine.' },
  { id: 'unity', label: 'Unity', hint: 'Cenas, prefabs, GUIDs e logs de projetos Unity lidos localmente, sem gastar tokens com YAML.', exe: 'Editor Unity (opcional)', placeholder: 'Unity.exe do Hub; vazio usa unity no PATH', note: 'As consultas não abrem o editor; o executável só serve para comandos locais.' },
  { id: 'blender', label: 'Blender', hint: 'Inspeção e auditoria de arquivos .blend em segundo plano, sem salvar e sem scripts embutidos.', exe: 'Executável Blender', placeholder: 'Vazio usa blender no PATH', note: 'Usado nas consultas dos agentes, em segundo plano. Salvar não inicia o Blender.' }
]
export function GroupDialog({ edit, count, onSave, onClose }: { edit?: Group; count: number; onSave: (name: string, color: string, engines: EngineSettings) => void; onClose: () => void }) {
  const [v, setV] = useState(edit?.name ?? '')
  const [color, setColor] = useState(edit?.color ?? GROUP_COLORS[0])
  const [engines, setEngines] = useState<Record<EngineId, EngineConfig>>(() => Object.fromEntries(ENGINE_UI.map(e => [e.id, edit?.[e.id] ?? { enabled: false, executable: '' }])) as Record<EngineId, EngineConfig>)
  const setEngine = (id: EngineId, v: Partial<EngineConfig>) => setEngines(all => ({ ...all, [id]: { ...all[id], ...v } }))
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [])
  const ok = v.trim().length > 0
  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal group-dlg" role="dialog" aria-modal="true" aria-label={edit ? 'Editar organizador' : 'Novo organizador'} style={{ '--g': color } as CSSProperties}
        onSubmit={e => { e.preventDefault(); if (ok) { onSave(v.trim().slice(0, 40), color, Object.fromEntries(ENGINE_UI.filter(e => e.id === 'godot' || engines[e.id].enabled || edit?.[e.id]).map(e => [e.id, { ...engines[e.id], executable: engines[e.id].executable.trim() || e.id }]))); onClose() } }}>
        <div className="gd-preview" aria-hidden="true">
          <span className="gd-folder">{initials(v.trim() || 'Wo')}</span>
          <span className="gd-name">{v.trim() || 'Nome do organizador'}</span>
        </div>
        <div className="gd-body">
          <h2>{edit ? 'Editar organizador' : 'Novo organizador'}</h2>
          <p>{edit ? 'Organização e ferramentas disponíveis para os projetos deste organizador.' : `Junta pastas de lugares diferentes num ícone; cada uma mantém as próprias conversas e terminais.${count ? ` ${count === 1 ? 'Esta pasta entra' : `As ${count} pastas entram`} nele.` : ''}`}</p>
          <input aria-label="Nome do organizador" autoFocus maxLength={40} placeholder="Ex.: Case Opened, Trabalho, Pessoais" value={v} onChange={e => setV(e.target.value)} />
          {!edit && <div className="gd-sugg">{SUGGESTED.map(([n, c]) => (
            <button type="button" key={n} className={v === n ? 'on' : ''} style={{ '--g': c } as CSSProperties} onClick={() => { setV(n); setColor(c) }}>{n}</button>
          ))}</div>}
          <div className="gd-colors" role="radiogroup" aria-label="Cor do organizador">
            {GROUP_COLORS.map(c => <button type="button" key={c} role="radio" aria-checked={c === color} aria-label={`Cor ${c}`} style={{ '--g': c } as CSSProperties} onClick={() => setColor(c)} />)}
          </div>
          {ENGINE_UI.map(e => <div className="gd-godot" key={e.id}>
            <label className="check"><input type="checkbox" checked={engines[e.id].enabled} onChange={x => setEngine(e.id, { enabled: x.target.checked })} />Ativar integração {e.label}</label>
            <small>{e.hint}</small>
            {engines[e.id].enabled && <label>{e.exe}<input aria-label={`Executável ${e.label} do organizador`} value={engines[e.id].executable} maxLength={2000} placeholder={e.placeholder} onChange={x => setEngine(e.id, { executable: x.target.value })} /><small>{e.note}</small></label>}
          </div>)}
        </div>
        <footer>
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={!ok}>{edit ? 'Salvar' : 'Criar organizador'}</button>
        </footer>
      </form>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { api, onChat } from './api'
import type { ReactNode } from 'react'

export type PulseEvent = { t: number; v: number; provider: string | null; del: boolean }
export type ProjPulse = { commits: number[]; dirt: { lines: number; files: number } | null }

const N = 90, SLOT = 40_000, HOUR = N * SLOT // 90 fatias de 40 s = ultima hora
const C = 32, R0 = 25, RMAX = 6 // marca pequena: 64 px
export const DIRT_FULL = 600 // linhas sem commit que enchem o anel. ponytail: valor fixo; tornar ajustavel se incomodar

const keep = <T,>(prev: T, next: T) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next) // igual: nada re-renderiza

// Dados do nucleo: gravacoes (memoria do processo principal, avisadas por evento) e, por projeto, commits e sujeira (git, a cada 30 s).
export function usePulse() {
  const [events, setEvents] = useState<Record<string, PulseEvent[]>>({})
  const [proj, setProj] = useState<Record<string, ProjPulse>>({})
  const [, setNow] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const loadEvents = () => api.pulseEvents().then((e: Record<string, PulseEvent[]>) => setEvents(prev => keep(prev, e)), () => {})
    const loadGit = () => api.projectsPulse().then((l: ({ game: string } & ProjPulse)[]) => setProj(prev => keep(prev, Object.fromEntries(l.map(p => [p.game, p])))), () => {})
    const visible = () => document.visibilityState === 'visible'
    loadEvents(); loadGit()
    const off = onChat(ev => {
      if (ev.pulse) { clearTimeout(timer); timer = setTimeout(() => { loadEvents(); loadGit() }, 400) }
      else if (ev.done) loadGit() // agente terminou: pode ter commitado
    })
    const t1 = setInterval(() => { if (visible()) setNow(n => n + 1) }, 10_000) // o relogio anda: tracos envelhecem e giram
    const t2 = setInterval(() => { if (visible()) loadGit() }, 30_000) // git so com a janela visivel
    return () => { off(); clearTimeout(timer); clearInterval(t1); clearInterval(t2) }
  }, [])
  return { events, proj }
}

const at = (i: number, r: number) => { const a = (-90 - (N - 1 - i) * 360 / N) * Math.PI / 180; return [C + r * Math.cos(a), C + r * Math.sin(a)] }
const slotOf = (t: number) => N - 1 - Math.floor((Date.now() - t) / SLOT)
// Azul calmo com pouca coisa sem commit, ambar no meio, vermelho perto de cheio.
export const dirtColor = (f: number) => `hsl(${f < .5 ? 200 - f * 330 : 35 - (f - .5) * 60} 85% ${f < .5 ? 68 : 62}%)`

// Marca da Orbita no topo do Inicio e da pasta: anel com a ultima hora de gravacoes (agora no topo, passado no sentido
// horario), commits como pontos claros e, no centro, o projeto (ou o nucleo). O arco so gira enquanto um agente trabalha.
export function OrbitMark({ events, commits, busy, thinking, children }: {
  events: PulseEvent[]; commits: number[]; busy: boolean; thinking?: boolean; children?: ReactNode
}) {
  const slots: { v: number; up: number; down: number; provider: string | null }[] = Array.from({ length: N }, () => ({ v: 0, up: 0, down: 0, provider: null }))
  for (const e of events) {
    const i = slotOf(e.t)
    if (i < 0 || i >= N) continue
    const s = slots[i]
    s.v += e.v; if (e.del) s.down += e.v; else s.up += e.v
    if (!s.provider || !e.del) s.provider = e.provider
  }
  return (
    <div className={`orbit-mark ${busy ? 'busy' : ''} ${thinking ? 'thinking' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <circle className="om-ring" cx={C} cy={C} r={R0 - 1} />
        <circle className="om-inner" cx={C} cy={C} r={R0 - 7} />
        {slots.map((s, i) => {
          if (!s.v) return null
          const len = Math.min(RMAX, 1.5 + Math.log2(1 + s.v)), [x1, y1] = at(i, R0 + .5), [x2, y2] = at(i, R0 + .5 + len)
          return <line key={i} className="om-seis" x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={s.down > s.up ? 'var(--hot)' : `var(--p-${s.provider ?? 'claude'}, var(--accent))`} opacity={(.3 + .7 * i / (N - 1)).toFixed(2)} />
        })}
        {commits.map(t => { const i = slotOf(t); if (i < 0 || i >= N) return null; const [x, y] = at(i, R0 - 1); return <circle key={t} className="om-commit" cx={x} cy={y} r="1.6" /> })}
        <g className="om-arc"><path d={`M${C} ${C - R0 + 1} A${R0 - 1} ${R0 - 1} 0 0 1 ${C + (R0 - 1) * Math.cos(-Math.PI / 6)} ${C + (R0 - 1) * Math.sin(-Math.PI / 6)}`} /><circle cx={C} cy={C - R0 + 1} r="2.4" /></g>
      </svg>
      <span className="om-core">{children ?? <i />}</span>
    </div>
  )
}

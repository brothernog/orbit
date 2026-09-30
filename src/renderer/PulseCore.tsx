import { useEffect, useState } from 'react'
import { api, onChat } from './api'
import { ProjectIcon } from './Nav'

export type PulseEvent = { t: number; v: number; provider: string | null; del: boolean }
export type ProjPulse = { commits: number[]; dirt: { lines: number; files: number } | null }

const N = 90, SLOT = 40_000, HOUR = N * SLOT // 90 fatias de 40 s = ultima hora
const C = 190, R0 = 122, RMAX = 40, RD = 104
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

// Nucleo da home: sismografo radial da ultima hora (agora no topo, passado no sentido horario), commits como losangos,
// anel de sujeira (linhas sem commit) e, no centro, o Jarvis/agentes ou o projeto em foco.
export function PulseCore({ events, commits, dirt, agents, thinking, focus }: {
  events: PulseEvent[]; commits: number[]; dirt: ProjPulse['dirt']; agents: number; thinking: boolean; focus: string | null
}) {
  const slots: { v: number; up: number; down: number; provider: string | null }[] = Array.from({ length: N }, () => ({ v: 0, up: 0, down: 0, provider: null }))
  for (const e of events) {
    const i = slotOf(e.t)
    if (i < 0 || i >= N) continue
    const s = slots[i]
    s.v += e.v; if (e.del) s.down += e.v; else s.up += e.v
    if (!s.provider || !e.del) s.provider = e.provider
  }
  const f = Math.min(1, (dirt?.lines ?? 0) / DIRT_FULL), L = 2 * Math.PI * RD
  let last = N - 1
  while (last >= 0 && !slots[last].v) last--
  return (
    <div className={`core ${agents ? 'busy' : ''} ${thinking ? 'thinking' : ''}`} aria-hidden="true">
      {/* Varredura e tracejado giram como camadas proprias (transform no compositor): girar dentro do SVG repintava tudo a cada quadro. */}
      <svg className="core-spin core-sweep" viewBox="0 0 380 380">
        <defs><linearGradient id="coreSweep" x1="0" x2="1"><stop offset="0" stopColor="#7cc4ff00" /><stop offset="1" stopColor="#7cc4ff2e" /></linearGradient></defs>
        <path d={`M${C} ${C} L${C} 52 A138 138 0 0 1 259 70 Z`} fill="url(#coreSweep)" />
      </svg>
      <svg viewBox="0 0 380 380">
        <defs>
          <radialGradient id="coreInner"><stop offset="0" stopColor="#7cc4ff1c" /><stop offset="1" stopColor="#7cc4ff05" /></radialGradient>
        </defs>
        {Array.from({ length: 60 }, (_, m) => { // mostrador: um risco por minuto, mais forte a cada 15
          const a = (-90 + m * 6) * Math.PI / 180, q = m % 15 === 0, r1 = R0 - 6, r2 = R0 - (q ? 12 : 9)
          return <line key={m} className={`core-hour ${q ? 'q' : ''}`} x1={C + r1 * Math.cos(a)} y1={C + r1 * Math.sin(a)} x2={C + r2 * Math.cos(a)} y2={C + r2 * Math.sin(a)} />
        })}
        {slots.map((s, i) => {
          if (!s.v) return null
          const len = Math.min(RMAX, 4 + Math.log2(1 + s.v) * 5.5), [x1, y1] = at(i, R0), [x2, y2] = at(i, R0 + len)
          return <line key={i} className={`core-seis ${i === last ? 'new' : ''}`} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={s.down > s.up ? 'var(--hot)' : `var(--p-${s.provider ?? 'claude'}, var(--accent))`} opacity={(.25 + .75 * i / (N - 1)).toFixed(2)} />
        })}
        {commits.map(t => {
          const i = slotOf(t)
          if (i < 0 || i >= N) return null
          const [x1, y1] = at(i, R0 - 14), [x2, y2] = at(i, R0 + RMAX + 8), [dx, dy] = at(i, R0 + RMAX + 14)
          return <g key={t}><line className="core-commit-line" x1={x1} y1={y1} x2={x2} y2={y2} /><rect className="core-commit" x={dx - 4} y={dy - 4} width="8" height="8" transform={`rotate(45 ${dx} ${dy})`} /></g>
        })}
        <circle className="core-dirt-track" cx={C} cy={C} r={RD} />
        <circle className="core-dirt" cx={C} cy={C} r={RD} style={{ strokeDasharray: `${L * f} ${L}`, stroke: dirtColor(f) }} />
        <circle className="core-inner" cx={C} cy={C} r="86" />
        {dirt && dirt.lines === 0 && commits.some(t => Date.now() - t < 90_000) && <circle key={Math.max(...commits)} className="core-flash" cx={C} cy={C} r={RD} />}
        <path className="core-now" d={`M${C} 36 l5 -9 h-10 z`} />
      </svg>
      <svg className="core-spin core-dash-spin" viewBox="0 0 380 380"><circle className="core-dash" cx={C} cy={C} r="74" /></svg>
      <div className="core-read" key={`${focus ?? '-'}${thinking}`}>
        {thinking ? <b className="core-think">pensando</b>
          : focus ? <><ProjectIcon game={focus} size={44} /><span>{agents ? `${agents} agente${agents > 1 ? 's' : ''} aqui` : 'nenhum agente aqui'}</span></>
          : <><b>{agents}</b><span>{agents === 1 ? 'agente trabalhando' : 'agentes trabalhando'}</span></>}
      </div>
    </div>
  )
}


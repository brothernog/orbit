import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, onChat } from './api'
import { chime, NoticeCard, NoticeGroup, type Notice } from './NoticeCard'
import { groupNotices } from './noticeGroups'
import { PROVIDER } from './icons'
import { resetText } from './usageText'
import './planet.css'

// Mesmo formato de planetUsage em src/main/index.ts: uma entrada por conta em uso; sem janela viva, vem sem pct.
type Acc = { key: string; source: string; pct?: number; window?: '5h' | 'semana'; resetsAt?: string; week?: number }
// planetState em index.ts: ligado e para que lado o aviso abre (na direcao do centro da tela).
type St = { on: boolean; right: boolean; bottom: boolean }
// moons em planet.ts: agente trabalhando (direto ou delegado); `gone` = acabou de sair (fica ate a animacao de saida terminar).
type MoonT = { key: string; slot: number; provider: string; delegated: boolean; waiting: boolean; title: string; gone?: boolean }

const R = 44 // raio do planeta no viewBox 132x132 (centro 66,66)
const RING = 2 * Math.PI * (R + 5)
const MAX = 3 // grupos de aviso visiveis
const SWAP = 10_000, POLL = 30_000, CLOSE = 520 // ms; CLOSE = duracao da animacao de fechar (planet.css)
const HUES = ['#7cc4ff', '#8fa2ff', '#6fdcc8', '#b99bff'] // uma cor calma por conta, estavel pela chave
const hue = (key: string) => HUES[[...key].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length]
// Orbitas das luas: inclinacao, raios e volta (s) por vaga; a vaga vem do id da execucao, entao uma lua que sai nao faz as outras pularem.
const ORBITS = [{ tilt: -18, rx: 56, ry: 15, dur: 9 }, { tilt: 14, rx: 53, ry: 19, dur: 12 }, { tilt: -30, rx: 56, ry: 11, dur: 15 }, { tilt: 24, rx: 53, ry: 22, dur: 11 }, { tilt: -6, rx: 56, ry: 17, dur: 18 }]
const orbitPath = (o: typeof ORBITS[number]) => `M${66 - o.rx} 66a${o.rx} ${o.ry} 0 1 0 ${2 * o.rx} 0a${o.rx} ${o.ry} 0 1 0 ${-2 * o.rx} 0`
const MOON_OUT = 700 // ms da animacao de saida (planet.css)
const level = (pct?: number) => (pct == null ? 'none' : pct >= 80 ? 'hot' : pct >= 60 ? 'warm' : 'calm')
// Quanto da janela ja passou (anel em volta): 5 h ou 7 dias ate resets_at.
const elapsed = (a: Acc) => {
  if (!a.resetsAt) return 0
  const len = a.window === '5h' ? 5 * 36e5 : 7 * 864e5
  return Math.max(0, Math.min(1, 1 - (Date.parse(a.resetsAt) - Date.now()) / len))
}
// Onda do mar: dois periodos de 44 a mais que a largura, para deslizar sem emenda (translateX -88 em loop).
const WAVE = `M0 0 ${Array.from({ length: 12 }, (_, i) => `Q${i * 22 + 11} ${i % 2 ? 3 : -3} ${i * 22 + 22} 0`).join(' ')} L264 150 L0 150 Z`

// A janela so cresce de verdade um pouco depois do setBounds: espera o resize (ou 300 ms) antes de animar, senao a animacao
// roda na janela ainda pequena e o aviso so "aparece".
const grown = () => new Promise<void>(res => {
  const done = () => { removeEventListener('resize', on); clearTimeout(t); res() }
  const on = () => { if (innerWidth > 200) done() }
  const t = setTimeout(done, 300)
  addEventListener('resize', on)
  on()
})

// Janela do planeta (processo principal: noticeWindow em index.ts). Planeta de uso das contas em uso, alternando a cada 10 s; com
// aviso, ele se abre e vira o cartao, e fecha de volta no planeta. O mar sobe com o % da janela de 5 h da conta (semanal so sem
// 5 h); sem dado, fica apagado e sem numero (nunca 0). Arraste para mover; clique traz a Orbita para a frente.
export function Planet() {
  const [accs, setAccs] = useState<Acc[] | undefined>()
  const [idx, setIdx] = useState(0)
  const [items, setItems] = useState<Notice[]>([])
  const [shown, setShown] = useState<Notice[]>([]) // segue na tela durante a animacao de fechar
  const [open, setOpen] = useState(false)
  const [st, setSt] = useState<St>({ on: true, right: true, bottom: true })
  const [moonList, setMoons] = useState<MoonT[]>([])
  const box = useRef<HTMLDivElement>(null)
  const live = useRef(false)
  live.current = items.length > 0

  useEffect(() => {
    const load = () => api.planetUsage().then((l: Acc[]) => setAccs(l), () => setAccs([]))
    load()
    const p = setInterval(load, POLL), s = setInterval(() => setIdx(i => i + 1), SWAP)
    api.noticeList().then((l: Notice[]) => setItems(l), () => {})
    api.planetState().then(setSt, () => {})
    const off = onChat(ev => {
      if (ev?.planet) setSt(ev.planet)
      const n: Notice | undefined = ev?.attention
      if (n) { setItems(l => [n, ...l.filter(x => x.key !== n.key && (x.taskId !== n.taskId || !x.command !== !n.command || x.taskId < 0))]); if (ev.sound) chime(n.kind) }
      if (ev?.noticeClear) setItems([])
    })
    return () => { clearInterval(p); clearInterval(s); off?.() }
  }, [])

  // Luas: a cada 3 s (so leitura no banco). A que sumiu da lista fica marcada `gone` para animar a saida e depois sai.
  useEffect(() => {
    const load = () => api.planetMoons().then((l: MoonT[]) => setMoons(prev => {
      const keys = new Set(l.map(m => m.key))
      return [...l, ...prev.filter(m => !keys.has(m.key) && !m.gone).map(m => ({ ...m, gone: true }))]
    }), () => {})
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!moonList.some(m => m.gone)) return
    const t = setTimeout(() => setMoons(l => l.filter(m => !m.gone)), MOON_OUT)
    return () => clearTimeout(t)
  }, [moonList])

  // Abrir: mede o cartao, a janela cresce e so entao o cartao se expande a partir do planeta. Fechar: anima e depois encolhe a janela.
  useEffect(() => {
    if (items.length) { setShown(items); return }
    setOpen(false)
    const t = setTimeout(() => { setShown([]); api.noticeFit(0) }, CLOSE)
    return () => clearTimeout(t)
  }, [items])
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !shown.length) return
    const fit = () => (live.current ? api.noticeFit(el.getBoundingClientRect().height) : Promise.resolve())
    let stop = false
    fit().then(grown).then(() => requestAnimationFrame(() => requestAnimationFrame(() => { if (!stop && live.current) setOpen(true) })))
    const ro = new ResizeObserver(() => { fit() })
    ro.observe(el)
    return () => { stop = true; ro.disconnect() }
  }, [shown.length])

  const dismiss = (n: Notice) => { setItems(l => l.filter(x => x.key !== n.key)); api.noticeDismiss(n.key) }
  const openTask = (n: Notice, files: boolean) => { setItems(l => l.filter(x => x.key !== n.key)); api.noticeOpen(n.key, files) }
  const groups = groupNotices(shown)
  const a = accs?.length ? accs[idx % accs.length] : undefined

  return (
    <div className={`corner ${open ? 'open' : ''} ${st.right ? 'right' : 'left'} ${st.bottom ? 'bottom' : 'top'} ${st.on ? '' : 'off'}`}
      style={{ '--bloom': st.on && a ? { hot: 'var(--hot)', warm: 'var(--limit)', calm: hue(a.key), none: 'var(--muted)' }[level(a.pct)] : undefined } as React.CSSProperties}>
      {shown.length > 0 && (
        <div className="nw" ref={box}>
          {groups.length > MAX && <div className="nc-overflow"><span>Mais {groups.length - MAX} {groups.length - MAX === 1 ? 'projeto' : 'projetos'} com avisos na Órbita</span></div>}
          {(st.bottom ? groups.slice(0, MAX).reverse() : groups.slice(0, MAX)).map(g => g.length === 1
            ? <NoticeCard key={g[0].key} n={g[0]} life={14} onOpen={f => openTask(g[0], f)} onDismiss={() => dismiss(g[0])} />
            : <NoticeGroup key={`g${g[0].key}`} items={g} life={14} onOpen={x => openTask(x, false)} onDismiss={dismiss} onDismissAll={() => g.forEach(dismiss)} />)}
        </div>
      )}
      {st.on && <Orb a={a} count={accs?.length ?? 0} at={accs?.length ? idx % accs.length : 0} loading={accs === undefined} drag={!shown.length} moons={moonList} />}
    </div>
  )
}

// Arrastar: a janela segue o ponteiro (posicao em DIP, a mesma do Electron); passou de 4 px, vira arrasto e o clique e ignorado.
const moonsText = (l: MoonT[]) => {
  const run = l.filter(m => !m.gone && !m.waiting).length, wait = l.filter(m => !m.gone && m.waiting).length
  return (run ? `\n${run} ${run === 1 ? 'agente trabalhando' : 'agentes trabalhando'}` : '') + (wait ? `\n${wait} esperando aprovação` : '')
}

function useDrag(enabled: boolean) {
  const d = useRef<{ sx: number; sy: number; wx: number; wy: number; moved: boolean } | null>(null)
  const moved = useRef(false)
  return {
    moved,
    onPointerDown: (e: React.PointerEvent) => {
      if (!enabled || e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      d.current = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: false }
      moved.current = false
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = d.current
      if (!s) return
      const dx = e.screenX - s.sx, dy = e.screenY - s.sy
      if (!s.moved && Math.hypot(dx, dy) < 4) return
      s.moved = moved.current = true
      api.planetDrag(s.wx + dx, s.wy + dy)
    },
    onPointerUp: () => { if (d.current?.moved) api.planetDrop(); d.current = null }
  }
}

// Luas em duas camadas com a mesma orbita: a metade de tras passa atras do planeta, a da frente por cima (clip no plano da orbita).
// Trabalhando: gira; esperando aprovacao: para na frente e pulsa. Entra crescendo, sai se afastando.
function Moons({ list, layer }: { list: MoonT[]; layer: 'back' | 'front' }) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  return <>{list.map(m => {
    const o = ORBITS[m.slot % ORBITS.length], d = orbitPath(o)
    return (
      <g key={m.key} transform={`rotate(${o.tilt} 66 66)`} clipPath={`url(#pl-${layer})`}>
        <path className={`pl-orbit ${m.gone ? 'gone' : ''}`} d={d} />
        <g className={`moon p-${m.provider} ${m.waiting ? 'wait' : ''} ${m.gone ? 'gone' : ''}`} transform={m.waiting || still ? `translate(66 ${66 + o.ry})` : undefined}>
          {!m.waiting && !still && <animateMotion dur={`${o.dur}s`} repeatCount="indefinite" path={d} />}
          <g className="mn-body">
            {layer === 'front' && <title>{`${PROVIDER[m.provider]?.label ?? m.provider}, ${m.waiting ? 'esperando aprovação' : m.delegated ? 'delegado' : 'trabalhando'}: ${m.title}`}</title>}
            {m.waiting && <circle className="mn-ping" r="5" />}
            <circle className="mn-glow" r="7" />
            <circle className="mn" r="4.2" />
          </g>
        </g>
      </g>
    )
  })}</>
}

function Orb({ a, count, at, loading, drag, moons }: { a?: Acc; count: number; at: number; loading: boolean; drag: boolean; moons: MoonT[] }) {
  const { moved, ...handlers } = useDrag(drag)
  const pct = a?.pct == null ? null : Math.max(0, Math.min(100, a.pct))
  const sea = pct == null ? 150 : 66 + R - (2 * R * pct) / 100 // topo do mar: 0% = base do planeta, 100% = topo
  const title = (!a ? (loading ? 'Lendo limites…' : 'Nenhuma conta em uso')
    : pct == null ? `${a.source}\nSem dados de limite`
    : `${a.source}\n${a.window === '5h' ? 'Limite de 5 horas' : 'Limite semanal'}: ${Math.round(a.pct!)}%\n${resetText(a.resetsAt!)}${a.week != null ? `\nSemana: ${Math.round(a.week)}%` : ''}`)
    + `${moonsText(moons)}\nArraste para mover`
  return (
    <button className={`planet ${level(a?.pct)}`} style={{ '--h': a ? hue(a.key) : undefined } as React.CSSProperties}
      title={title} aria-label={title} {...handlers} onClick={() => { if (!moved.current) api.planetOpen() }}>
      <svg viewBox="0 0 132 132" aria-hidden="true">
        <defs>
          <clipPath id="pl-body"><circle cx="66" cy="66" r={R} /></clipPath>
          <clipPath id="pl-back"><rect x="-20" y="-20" width="172" height="86" /></clipPath>
          <clipPath id="pl-front"><rect x="-20" y="66" width="172" height="86" /></clipPath>
          <radialGradient id="pl-shade" cx="35%" cy="30%" r="75%">
            <stop offset="0" stopColor="#fff" stopOpacity=".24" />
            <stop offset=".5" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity=".6" />
          </radialGradient>
        </defs>
        <Moons list={moons} layer="back" />
        <g className="pl-orb">
          <circle className="pl-glow" cx="66" cy="66" r={R + 6} />
          <circle className="pl-track" cx="66" cy="66" r={R + 5} />
          {a?.resetsAt && <circle className="pl-ring" cx="66" cy="66" r={R + 5} strokeDasharray={RING} strokeDashoffset={RING * (1 - elapsed(a))} transform="rotate(-90 66 66)" />}
          <g clipPath="url(#pl-body)">
            <circle className="pl-land" cx="66" cy="66" r={R} />
            <g className="pl-drift">
              {[0, 132].map(x => <g key={x} transform={`translate(${x} 0)`}>
                <ellipse cx="40" cy="48" rx="22" ry="7" /><ellipse cx="92" cy="78" rx="26" ry="8" /><ellipse cx="58" cy="96" rx="14" ry="4" />
              </g>)}
            </g>
            <g className="pl-sea" style={{ transform: `translateY(${sea}px)` }}>
              <path className="pl-wave back" d={WAVE} />
              <path className="pl-wave" d={WAVE} />
            </g>
            <circle cx="66" cy="66" r={R} fill="url(#pl-shade)" />
          </g>
          <circle className="pl-rim" cx="66" cy="66" r={R} />
        </g>
        <Moons list={moons} layer="front" />
        {a && <g key={a.key} className="pl-label">
          {pct != null && <text className="pl-pct" x="66" y="70" textAnchor="middle">{Math.round(pct)}%</text>}
          <text className="pl-who" x="66" y={pct != null ? 84 : 70} textAnchor="middle">{a.source.replace(/^Claude, /, '').slice(0, 12)}</text>
        </g>}
        {count > 1 && <g className="pl-dots">
          {Array.from({ length: count }, (_, i) => <circle key={i} className={i === at ? 'on' : ''} cx={66 + (i - (count - 1) / 2) * 8} cy="124" r="2" />)}
        </g>}
      </svg>
    </button>
  )
}

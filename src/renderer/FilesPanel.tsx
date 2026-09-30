import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { api, errText, onChat, type Task } from './api'
import { Icon } from './icons'

type File = { path: string; status: 'M' | 'A' | 'D' | '?'; added: number | null; removed: number | null; lastWrite: number | null }
type State = { repo: boolean; isolated: boolean; files: File[] }
type Tick = { h: number; del: boolean }

const HOT_MS = 6000
const split = (p: string) => { const i = p.lastIndexOf('/'); return [p.slice(i + 1), i >= 0 ? p.slice(0, i + 1) : ''] }
const size = (f: File) => (f.added ?? 0) + (f.removed ?? 0)

// Diff para a tela. Modo "so o alterado": sem linhas de contexto e com "linha N" no lugar do cabecalho do trecho; arquivo inteiro: contexto fica.
const diffLines = (d: string, all: boolean) => d.split('\n').flatMap((l, i) => {
  if (l[0] === '\\') return []
  if (l.startsWith('@@')) { const n = /\+(\d+)/.exec(l)?.[1]; return all ? [] : [<span key={i} className="h">{n ? `linha ${n}` : l}{'\n'}</span>] }
  if (!all && l[0] === ' ') return []
  return [<span key={i} className={l[0] === '+' ? 'p' : l[0] === '-' ? 'm' : ''}>{l}{'\n'}</span>]
})

// Sismografo: cada traco e uma rodada de gravacoes; a altura e quantas linhas mudaram (escala log), vermelho quando mais saiu que entrou.
function Seismo({ ticks, n = 48 }: { ticks: Tick[]; n?: number }) {
  const t = ticks.slice(-n)
  return (
    <svg className="seismo" viewBox={`0 0 ${n} 24`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={n} y1="23.5" y2="23.5" className="seismo-base" />
      {t.map((k, i) => <line key={ticks.length - t.length + i} x1={n - t.length + i + .5} x2={n - t.length + i + .5} y1="23.5" y2={23.5 - k.h}
        className={`seismo-tick ${k.del ? 'del' : ''} ${i === t.length - 1 ? 'fresh' : ''}`} />)}
    </svg>
  )
}

// Arquivos que a tarefa esta mudando, ao vivo. Tudo vem do disco e do Git pelo processo principal: nao gasta tokens.
export function FilesPanel({ task, provider, onClose }: { task: Task; provider?: string; onClose: () => void }) {
  const [st, setSt] = useState<State | null>(null)
  const [err, setErr] = useState('')
  const [ticks, setTicks] = useState<Tick[]>([])
  const [hot, setHot] = useState<Record<string, number>>({})
  const [open, setOpen] = useState<Record<string, string | null>>({}) // caminho -> diff (null = carregando)
  const [full, setFull] = useState<Record<string, boolean>>({}) // caminho -> olho ligado: arquivo inteiro em vez de so o alterado
  const [shut, setShut] = useState<Record<string, boolean>>({}) // pastas recolhidas
  const [, setNow] = useState(0)
  const prev = useRef<Map<string, number> | null>(null)
  const wrote = useRef(false)
  const openRef = useRef(open)
  openRef.current = open
  const fullRef = useRef(full)
  fullRef.current = full
  const fetchDiff = (p: string, f = fullRef.current[p] === true) => api.fileDiff(task.id, p, f).then((t: string) => setOpen(o => (p in o ? { ...o, [p]: t } : o)), (e: any) => setOpen(o => (p in o ? { ...o, [p]: errText(e) } : o)))

  const load = () => api.taskFiles(task.id).then((s: State) => {
    // traco do sismografo: o quanto as contagens mudaram desde a ultima leitura
    const cur = new Map(s.files.map(f => [f.path, size(f)]))
    if (prev.current) {
      let up = 0, down = 0
      for (const [p, n] of cur) { const d = n - (prev.current.get(p) ?? 0); if (d > 0) up += d; else down -= d }
      for (const [p, n] of prev.current) if (!cur.has(p)) down += n
      const total = up + down
      if (total || wrote.current) setTicks(t => [...t.slice(-95), { h: total ? Math.min(22, 3 + Math.log2(1 + total) * 3) : 2, del: down > up }])
    }
    prev.current = cur
    wrote.current = false
    setSt(s); setErr('')
    Object.keys(openRef.current).forEach(p => fetchDiff(p)) // diffs abertos recarregam junto (o texto antigo fica ate o novo chegar)
  }, (e: any) => setErr(errText(e)))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => { clearTimeout(timer); timer = setTimeout(load, 600) }
    prev.current = null; setTicks([]); setSt(null); setOpen({}); setFull({}); setShut({}); setHot({})
    load()
    const off = onChat(ev => {
      if (ev.fileWrite?.taskId === task.id) { wrote.current = true; setHot(h => ({ ...h, [ev.fileWrite.path]: Date.now() })); soon() }
      else if (ev.taskId === task.id && (ev.done || ev.refresh)) soon()
    })
    const slow = setInterval(load, 15_000) // commit ou mudanca feita fora do app
    return () => { off(); clearTimeout(timer); clearInterval(slow); api.stopFiles().catch(() => {}) }
  }, [task.id])

  const last = (f: File) => Math.max(f.lastWrite ?? 0, hot[f.path] ?? 0)
  const anyHot = st?.files.some(f => Date.now() - last(f) < HOT_MS)
  useEffect(() => { if (!anyHot) return; const t = setInterval(() => setNow(n => n + 1), 1000); return () => clearInterval(t) }, [anyHot])

  const files = [...(st?.files ?? [])].sort((a, b) => last(b) - last(a) || a.path.localeCompare(b.path))
  const add = files.reduce((n, f) => n + (f.added ?? 0), 0), del = files.reduce((n, f) => n + (f.removed ?? 0), 0)
  const toggle = (p: string) => {
    if (p in open) { const { [p]: _, ...rest } = open; setOpen(rest) }
    else { setOpen({ ...open, [p]: null }); fetchDiff(p) }
  }
  const toggleFull = (p: string) => { const f = !full[p]; setFull({ ...full, [p]: f }); setOpen(o => ({ ...o, [p]: null })); fetchDiff(p, f) }
  // Arquivos agrupados por pasta; a ordem das pastas segue o arquivo mais recente de cada uma.
  const groups = new Map<string, File[]>()
  for (const f of files) { const dir = split(f.path)[1]; groups.set(dir, [...(groups.get(dir) ?? []), f]) }

  return (
    <aside className="panel files-panel" aria-label="Arquivos alterados" style={{ '--c': provider ? `var(--p-${provider})` : 'var(--accent)' } as CSSProperties}>
      <header>
        <h2 className="panel-title" title="Lidos do disco e do Git pelo próprio app. Não usa IA nem tokens.">Arquivos alterados</h2>
        <button className="icon" aria-label="Fechar arquivos" title="Fechar arquivos" onClick={onClose}><Icon n="close" size={16} /></button>
      </header>
      <Seismo ticks={ticks} />
      {st && !st.isolated && <p className="fp-note">Pasta do projeto: pode incluir mudanças suas ou de outras tarefas. Isolar a tarefa em worktree separa só as dela.</p>}
      {err && <p className="fp-note err">{err}</p>}
      {!st && !err ? <span className="loader" aria-label="Lendo arquivos" />
        : st && files.length === 0 ? <p className="fp-empty">Nada mudou ainda. Quando o agente gravar um arquivo, ele aparece aqui na hora.</p>
        : <ol className="fp-list">
            {[...groups].map(([dir, list]) => {
              const a = list.reduce((n, f) => n + (f.added ?? 0), 0), d = list.reduce((n, f) => n + (f.removed ?? 0), 0)
              return (
                <li key={dir} className="fp-group">
                  <button className="fp-dirhead" aria-expanded={!shut[dir]} onClick={() => setShut({ ...shut, [dir]: !shut[dir] })}>
                    <Icon n="chevron" size={13} /><span className="fp-dirname">{dir || './'}</span><span className="fp-count">{list.length}</span>
                    <span className="fp-delta">{a ? <span className="a">+{a}</span> : null} {d ? <span className="d">−{d}</span> : null}</span>
                  </button>
                  {!shut[dir] && <ol className="fp-sub">{list.map(f => {
                    const file = split(f.path)[0], isHot = Date.now() - last(f) < HOT_MS, t = open[f.path], all = full[f.path] === true
                    return (
                      <li key={f.path} className={`fp-file ${isHot ? 'hot' : ''} st-${f.status === '?' ? 'u' : f.status}`}>
                        <button aria-expanded={f.path in open} title={f.path} onClick={() => toggle(f.path)}>
                          <span className="fp-name">{file}{f.status === '?' || f.status === 'A' ? <em className="fp-new">novo</em> : f.status === 'D' ? <em className="fp-del">removido</em> : null}{isHot && <em className="fp-hot">gravando</em>}</span>
                          <span className="fp-delta">{f.added == null && f.removed == null ? <span title="Binário ou sem contagem">bin</span>
                            : <>{f.added ? <span className="a">+{f.added}</span> : null} {f.removed ? <span className="d">−{f.removed}</span> : null}</>}</span>
                        </button>
                        {f.path in open && <>
                          <div className="fp-dhead">
                            <span>{all ? 'Arquivo inteiro' : 'Só o alterado'}</span>
                            <button className={`icon sm ${all ? 'on' : ''}`} aria-pressed={all} aria-label="Ver o arquivo inteiro" title={all ? 'Ver só o alterado' : 'Ver o arquivo inteiro'} onClick={() => toggleFull(f.path)}><Icon n="eye" size={15} /></button>
                          </div>
                          {t == null ? <span className="loader sm" aria-label="Carregando diff" />
                            : <pre className="fp-diff">{diffLines(t, all)}</pre>}
                        </>}
                      </li>
                    )
                  })}</ol>}
                </li>
              )
            })}
          </ol>}
      {st && files.length > 0 && <footer className="fp-foot">
        <span>{files.length} {files.length === 1 ? 'arquivo' : 'arquivos'}</span>
        {st.repo && <><span className="a">+{add}</span><span className="d">−{del}</span></>}
      </footer>}
    </aside>
  )
}

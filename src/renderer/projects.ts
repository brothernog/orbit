// Estado real dos projetos (tipo, Git, atividade), com cache curto: varias telas pedem o mesmo projeto.
import { useEffect, useState } from 'react'
import { api, onChat } from './api'

export type FileChange = { path: string; status: 'M' | 'A' | 'D' | '?' }
export type GitState = { branch: string | null; upstream: string | null; ahead: number; behind: number; files: FileChange[] }
export type Worktree = GitState & { path: string; taskId: number | null; task: string | null }
export type Info = {
  kind: 'game' | 'app'; stack: string; repo: boolean; git: GitState | null; worktrees: Worktree[]
  lastActivity: string | null; openTasks: number; error?: string
}

const cache = new Map<string, { at: number; info: Info }>()
const inflight = new Map<string, Promise<Info>>() // telas que pedem o mesmo projeto juntas dividem a consulta
const get = (g: string, maxAge: number) => {
  const c = cache.get(g)
  if (c && Date.now() - c.at < maxAge) return Promise.resolve(c.info)
  let p = inflight.get(g)
  if (!p) {
    p = api.projectInfo(g).then((info: Info) => { if (inflight.get(g) === p) cache.set(g, { at: Date.now(), info }); return info })
      .finally(() => { if (inflight.get(g) === p) inflight.delete(g) })
    inflight.set(g, p)
  }
  return p
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
// Projetos que um evento mudou de verdade (worktree, agente terminou: o Git provavelmente mudou); done sem projeto vale para todos.
const changedBy = (ev: any, games: string[]) =>
  typeof ev.worktreesChanged === 'string' ? games.filter(g => same(g, ev.worktreesChanged))
    : ev.done ? (typeof ev.game === 'string' ? games.filter(g => same(g, ev.game)) : games)
    : []
// Um so ouvinte descarta cache e consulta em voo (podem ser de antes da mudanca), antes dos hooks recarregarem: registrado no
// carregamento do modulo, roda antes deles, e os hooks do mesmo projeto passam a dividir UMA consulta nova.
onChat(ev => changedBy(ev, [...new Set([...cache.keys(), ...inflight.keys()])]).forEach(g => { cache.delete(g); inflight.delete(g) }))

// ponytail: polling (Git muda fora do app, sem evento); troca por watcher de .git se ficar pesado.
// O intervalo aceita um resultado com ate metade do periodo: dois hooks do mesmo projeto (Inicio + visao geral) nao consultam em dobro.
export function useProjects(games: string[], everyMs = 60_000) {
  const [map, setMap] = useState<Record<string, Info>>(() => Object.fromEntries(games.flatMap(g => (cache.has(g) ? [[g, cache.get(g)!.info]] : []))))
  const key = games.join('|')
  useEffect(() => {
    let live = true
    const put = (g: string, i: Info) => live && setMap(m => (m[g] && JSON.stringify(m[g]) === JSON.stringify(i) ? m : { ...m, [g]: i }))
    const latest: Record<string, Promise<Info>> = {} // resposta antiga que chega depois da nova nao sobrescreve
    const load = (list: string[], maxAge: number) => list.forEach(g => { const p = latest[g] = get(g, maxAge); p.then(i => latest[g] === p && put(g, i), () => {}) })
    load(games, everyMs)
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(games, everyMs / 2) }, everyMs)
    const off = onChat(ev => load(changedBy(ev, games), 0))
    return () => { live = false; clearInterval(t); off() }
  }, [key])
  return map
}

export const dirtyCount = (i?: Info) => (i?.git?.files.length ?? 0) + (i?.worktrees.reduce((n, w) => n + w.files.length, 0) ?? 0)
export const minutesSince = (iso: string | null) => (iso ? (Date.now() - new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime()) / 60000 : Infinity)

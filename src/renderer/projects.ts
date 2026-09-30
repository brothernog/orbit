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
const get = (g: string, maxAge: number) => {
  const c = cache.get(g)
  if (c && Date.now() - c.at < maxAge) return Promise.resolve(c.info)
  return api.projectInfo(g).then((info: Info) => { cache.set(g, { at: Date.now(), info }); return info })
}

// ponytail: polling (Git muda fora do app, sem evento); troca por watcher de .git se ficar pesado.
export function useProjects(games: string[], everyMs = 60_000) {
  const [map, setMap] = useState<Record<string, Info>>(() => Object.fromEntries(games.flatMap(g => (cache.has(g) ? [[g, cache.get(g)!.info]] : []))))
  const key = games.join('|')
  useEffect(() => {
    let live = true
    const load = (maxAge: number) => games.forEach(g => get(g, maxAge).then(i => live && setMap(m => ({ ...m, [g]: i })), () => {}))
    load(everyMs)
    const t = setInterval(() => load(0), everyMs)
    const off = onChat(ev => {
      if (games.includes(ev.worktreesChanged)) { cache.delete(ev.worktreesChanged); load(0) }
      else if (ev.done) load(0) // agente terminou: Git provavelmente mudou
    })
    return () => { live = false; clearInterval(t); off() }
  }, [key])
  return map
}

export const dirtyCount = (i?: Info) => (i?.git?.files.length ?? 0) + (i?.worktrees.reduce((n, w) => n + w.files.length, 0) ?? 0)
export const minutesSince = (iso: string | null) => (iso ? (Date.now() - new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime()) / 60000 : Infinity)

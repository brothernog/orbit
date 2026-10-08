import type { OrbitActivity, OrbitAgent } from './api.ts'

export type OrbitPosition = { line: number; endLine?: number; position: 'reported' | 'diff' }
export type OrbitDiskFile = { path: string; added: number | null; removed: number | null; lastWrite: number | null }
export const isOrbitProjectPath = (path?: string): path is string => !!path && !/^(?:[a-z]:|[\\/])/i.test(path)

// Eventos recebidos enquanto a consulta estava em voo têm prioridade sobre a fotografia inicial.
export function mergeOrbitAgents(snapshot: OrbitAgent[], received: Iterable<OrbitAgent>): OrbitAgent[] {
  return [...new Map([...snapshot, ...received].map(agent => [agent.id, agent])).values()]
}

export function latestOrbitFile(agent?: OrbitAgent): OrbitActivity | undefined {
  if (agent?.activity?.path) return agent.activity
  if (agent?.lastFile?.path) return agent.lastFile
  for (let i = (agent?.events.length ?? 0) - 1; i >= 0; i--) if (agent!.events[i].path) return agent!.events[i]
}

// O diff só fornece uma estimativa. Uma exclusão sem linhas novas ancora na linha sobrevivente.
export function orbitDiffPosition(diff: string): OrbitPosition | undefined {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/m.exec(diff)
  if (!match) return undefined
  const line = Math.max(1, Number(match[1])), count = match[2] === undefined ? 1 : Number(match[2])
  return { line, endLine: line + Math.max(0, count - 1), position: 'diff' }
}

// Contagens do Git podem ser compartilhadas; só visitas e gravações desta tarefa criam pontos.
export function orbitTaskFiles(agents: OrbitAgent[], disk: OrbitDiskFile[], writes: Record<string, number>, now: number) {
  const paths = new Set(Object.keys(writes)), visitedAt = new Map<string, number>(), edits = new Map<string, OrbitActivity>()
  for (const agent of agents) {
    for (const path of agent.visited ?? []) paths.add(path)
    for (const event of [...agent.events, ...(agent.lastFile ? [agent.lastFile] : []), ...(agent.activity ? [agent.activity] : [])]) if (event.path) {
      paths.add(event.path); visitedAt.set(event.path, Math.max(visitedAt.get(event.path) ?? 0, event.at))
      if (event.kind === 'edit' && (event.added != null || event.removed != null) && event.at >= (edits.get(event.path)?.at ?? 0)) edits.set(event.path, event)
    }
  }
  const counts = new Map(disk.map(file => [file.path, file]))
  return [...paths].filter(isOrbitProjectPath).map(path => {
    const file = counts.get(path), edit = edits.get(path)
    return { path, added: file?.added ?? null, removed: file?.removed ?? null,
      ...(edit ? { editAdded: edit.added, editRemoved: edit.removed } : {}),
      updatedAt: Math.max(writes[path] ?? 0, file?.lastWrite ?? 0, visitedAt.get(path) ?? 0),
      hot: now - Math.max(writes[path] ?? 0, file?.lastWrite ?? 0) < 6000 }
  }).sort((a, b) => a.path.localeCompare(b.path))
}

// Linhas adicionadas (numeração do arquivo novo) em todos os hunks do diff.
export function orbitAddedLines(diff: string): Set<number> {
  const added = new Set<number>()
  let line = 0, inHunk = false
  for (const row of diff.split('\n')) {
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (head) { line = Number(head[1]); inHunk = true; continue }
    if (!inHunk || row.startsWith('\\')) continue
    if (row.startsWith('+')) added.add(line++)
    else if (row.startsWith(' ')) line++
  }
  return added
}

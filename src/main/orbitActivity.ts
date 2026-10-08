// Observabilidade local: nunca alimenta prompts, memoria ou pacotes de contexto.
import type { Activity } from './agentActivity.ts'
import { randomUUID } from 'node:crypto'

export type OrbitActivity = Omit<Activity, 'fullText'> & { at: number; textId?: string }
export type OrbitAgent = { id: string; provider: string; active: boolean; activity?: OrbitActivity; lastFile?: OrbitActivity; visited?: string[]; events: OrbitActivity[]; historyTruncated?: boolean }

export function createOrbitActivityStore() {
  const tasks = new Map<number, Map<string, OrbitAgent>>()
  const texts = new Map<string, { taskId: number; agentId: string; ref?: string; text: string }>()
  let textChars = 0
  const dropText = (id: string) => { const t = texts.get(id); if (t) textChars -= t.text.length; texts.delete(id) }
  const forget = (taskId: number) => { tasks.delete(taskId); for (const [id, t] of texts) if (t.taskId === taskId) dropText(id) }
  const update = (taskId: number, id: string, provider: string, active: boolean, activity?: Activity): OrbitAgent => {
    let agents = tasks.get(taskId)
    tasks.delete(taskId)
    tasks.set(taskId, agents ??= new Map())
    while (tasks.size > 12) forget(tasks.keys().next().value!)
    const prior = agents.get(id)
    const { fullText, ...preview } = activity ?? { kind: 'tool' as const }
    let textId: string | undefined
    if (fullText) {
      textId = activity?.ref ? [...texts].find(([, t]) => t.taskId === taskId && t.agentId === id && t.ref === activity.ref)?.[0] : undefined
      textId ??= randomUUID()
      dropText(textId)
      texts.set(textId, { taskId, agentId: id, ref: activity?.ref, text: fullText })
      textChars += fullText.length
      // Texto completo fica fora das fotografias IPC; carregado em paginas somente quando solicitado.
      while (textChars > 32_000_000) dropText(texts.keys().next().value!)
    }
    // Eventos encaminhados sao relatados pela perspectiva do pai; a aba mostra a perspectiva do filho.
    const direction = preview.kind !== 'message' ? undefined : preview.agent && preview.direction
      ? preview.direction === 'sent' ? 'received' : 'sent' : preview.direction
    const event: OrbitActivity | undefined = activity && { ...preview, direction, ...(textId ? { textId } : {}), at: Date.now() }
    let events = [...(prior?.events ?? [])]
    if (event) {
      const last = events.at(-1)
      const same = last && JSON.stringify({ ...last, at: 0 }) === JSON.stringify({ ...event, at: 0 })
      if (!same) events.push(event)
      // Atualizacoes cumulativas de um bloco de raciocinio substituem o mesmo bloco.
      if ((event.kind === 'thinking' || event.kind === 'message') && event.ref && events.length > 1) events = events.filter((e, i) => i === events.length - 1 || e.kind !== event.kind || e.ref !== event.ref)
    }
    let chars = events.reduce((n, e) => n + (e.summary?.length ?? 0), 0)
    let historyTruncated = prior?.historyTruncated
    while (events.length > 96 || chars > 128_000) { chars -= events.shift()!.summary?.length ?? 0; historyTruncated = true }
    const lastFile = event?.path ? event : prior?.lastFile
    const visited = event?.path ? [...(prior?.visited ?? []).filter(p => p !== event.path), event.path].slice(-200) : prior?.visited
    const agent: OrbitAgent = { id, provider, active, activity: event ?? prior?.activity, lastFile, visited, events, ...(historyTruncated ? { historyTruncated } : {}) }
    agents.set(id, agent)
    while (agents.size > 16) {
      const oldest = [...agents.values()].find(a => !a.active && a.id !== id) ?? agents.values().next().value!
      agents.delete(oldest.id)
    }
    return agent
  }
  return {
    record: (taskId: number, id: string, provider: string, activity: Activity) => update(taskId, id, provider, true, activity),
    finish: (taskId: number, id: string, provider: string) => update(taskId, id, provider, false),
    snapshot: (taskId: number) => ({ agents: [...(tasks.get(taskId)?.values() ?? [])] }),
    text: (taskId: number, agentId: string, textId: string, offset = 0) => {
      const value = texts.get(textId)
      if (!value || value.taskId !== taskId || value.agentId !== agentId) return { text: null, next: null, total: 0 }
      const end = Math.min(offset + 64_000, value.text.length)
      return { text: value.text.slice(offset, end), next: end < value.text.length ? end : null, total: value.text.length }
    },
    forget
  }
}

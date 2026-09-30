// Modelo unico de atencao: o mesmo estado alimenta a gaveta, o trilho, o dock, o Inicio e a visao do projeto.
// Ordem = prioridade: o que pede voce vem antes do que so esta andando. Toda contagem aponta para linhas visiveis.
import { useEffect, useState } from 'react'
import type { Active, Task } from './api'
import type { Brief } from './TaskBrief'

export type Attention = 'wait' | 'error' | 'unseen' | 'working' | 'idle' | 'done'
export const RANK: Record<Attention, number> = { wait: 0, error: 1, unseen: 2, working: 3, idle: 4, done: 5 }
export const ATTENTION_LABEL: Record<Attention, string> = {
  wait: 'Precisa de você', error: 'Falhou', unseen: 'Pronto para revisar', working: 'Trabalhando', idle: 'Aberta', done: 'Concluída'
}

// "Visto": ultima vez que a conversa esteve aberta na tela. Resposta concluida depois disso = pronta para revisar.
const KEY = 'seenAt'
const read = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} } }
let seen = read()
const subs = new Set<() => void>()
export function markSeen(taskId: number) {
  seen = { ...seen, [taskId]: Date.now() }
  try { localStorage.setItem(KEY, JSON.stringify(seen)) } catch {}
  subs.forEach(f => f())
}
export function useSeen() {
  const [, bump] = useState(0)
  useEffect(() => { const f = () => bump(n => n + 1); subs.add(f); return () => { subs.delete(f) } }, [])
  return seen
}
const ts = (iso: string) => new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime()

export function attentionOf(t: Task, b: Brief | undefined, who: Active | undefined, seenAt = seen[t.id]): Attention {
  if (b?.permission) return 'wait'
  if (who) return 'working'
  if (b?.awaiting) return 'wait'
  if (t.state === 'concluida') return 'done'
  if (b?.last === 'failed') return 'error'
  // Sem registro de visto (tarefas antigas, primeira abertura) nao inventa pendencia.
  if (b?.last === 'completed' && seenAt != null && ts(t.updated_at) > seenAt) return 'unseen'
  return 'idle'
}
export const needsYou = (a: Attention) => a === 'wait' || a === 'error' || a === 'unseen'

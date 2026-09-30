// Ponte com o processo principal (ver src/preload/index.ts) e tipos compartilhados da interface.
import { expireRead, invalidateRead, setRead } from './readCache.ts'

const settingsReads: Record<string, string> = {
  setContextLimits: 'getContextLimits', setNotifySettings: 'getNotifySettings', setJarvisSettings: 'getJarvisSettings',
  setDelegationSettings: 'getDelegationSettings', setPermissionSettings: 'getPermissionSettings',
  setAgentAliases: 'getAgentAliases', setSummaryTitles: 'summaryTitles', setAutomations: 'getAutomations', setHandover: 'getHandover'
}
const changedLists: Record<string, string[]> = {
  addPermissionRule: ['listPermissionRules', 'listPermissionRequests'],
  removePermissionRule: ['listPermissionRules', 'listPermissionRequests'],
  resolvePermissionRequest: ['listPermissionRules', 'listPermissionRequests'],
  hideGame: ['listHidden'], unhideGame: ['listHidden']
}
export const api = new Proxy({} as Record<string, (...a: any[]) => Promise<any>>, {
  get: (_t, name: string) => (...args: any[]) => {
    const read = settingsReads[name]
    if (read) expireRead(read)
    changedLists[name]?.forEach(expireRead)
    return (window as any).invoke(name, ...args).then((value: any) => {
      if (read && value !== undefined) setRead(read, value)
      return value
    })
  }
})

export const AGENTS = ['claude', 'codex', 'gemini', 'opencode']

export type Login = { state: 'connecting' | 'connected' | 'error'; error?: string } | null
export type Account = { id: number; name: string; config_dir: string | null; collision?: boolean; login?: Login }
export type Auth = { state: 'connected' | 'disconnected' | 'unknown'; detail?: string; email?: string; plan?: string }
export type Provider = {
  id: string; exe: string | null; version: string | null; capabilities: string[]; missing: string[]; env: string[]; failed?: string
  auth?: Auth; lastError?: { at: string; code: number; category: string; detail: string } | null
}
export type Pin = { id: number; game: string; title: string; body: string; status: string; agent?: string; branch?: string; worktree?: string }
export type Task = {
  id: number; game: string; title: string; state: 'aberta' | 'andamento' | 'concluida'; legacy: string | null; pin_id: number | null
  branch: string | null; worktree: string | null; created_at: string; updated_at: string; archived_at: string | null
  messages?: number; running?: boolean
  sel?: string | null // JSON da escolha de provedor/perfil/modelo/esforco da tarefa
}
export type Msg = {
  id: number; role: 'user' | 'agent' | 'system'; text: string; status?: 'completed' | 'failed' | 'cancelled' | null
  provider?: string | null; account_id?: number | null; model?: string | null; effort?: string | null; created_at: string
}
export type Sel = { provider: string; accountId?: number; model?: string; effort?: string }
export type ModelOpt = { id: string; label?: string; efforts: string[] | null; defaultEffort?: string | null; contextWindow?: number | null }
export type Catalog = {
  provider: string; source: 'native' | 'help' | 'manual'; at: string; models: ModelOpt[]; efforts: string[]
  allowCustomModel: boolean; note?: string; error?: string
}
export type Metric = {
  model: string | null; effort: string | null; occupied: number | null; capacity: number | null; estimated: boolean
  consumed_in: number | null; consumed_out: number | null; scope: string | null; source: string | null; at: string
}

// Eventos de streaming do chat: { taskId, text } enquanto executa e { taskId, done } ao terminar.
const listeners = new Set<(ev: any) => void>()
;(window as any).onChat?.((ev: any) => {
  if (Number.isSafeInteger(ev.accountUsage?.accountId)) {
    const key = `accountUsage:${ev.accountUsage.accountId}`
    if (ev.accountUsage.usage === null) {
      invalidateRead(key)
      invalidateRead(`accountStatus:${ev.accountUsage.accountId}`)
    } else setRead(key, ev.accountUsage.usage)
  }
  listeners.forEach(f => f(ev))
})
export const onChat = (f: (ev: any) => void) => {
  listeners.add(f)
  return () => { listeners.delete(f) }
}

export const errText = (e: any) => String(e?.message ?? e).replace(/^.*Error: /, '')
// Nome de exibicao: apelido dado pelo usuario (Renomear projeto) ou o nome da pasta.
let aliases: Record<string, string> = {}
export const setAliases = (a: Record<string, string>) => { aliases = a }
export const name = (p: string) => aliases[p] ?? p.split(/[\\/]/).pop()!
export const depth = (p: string) => p.split(/[\\/]/).length

// Um agente trabalhando agora: conversa de tarefa ou delegacao entre provedores.
export type Active = { kind: 'chat' | 'delegation'; id: number; taskId: number; game: string; title: string; provider: string; model: string | null; startedAt: number; doing?: { tool: string; detail?: string } }

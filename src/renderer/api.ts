// Ponte com o processo principal (ver src/preload/index.ts) e tipos compartilhados da interface.
import { expireRead, invalidateRead, setRead } from './readCache.ts'
import { SETTINGS_READS } from '../main/settingsReads.ts'
import type { Catalog, ModelOpt } from '../main/catalog.ts'
import type { SendResult } from '../main/chatService.ts'
import type { TaskAgent } from '../main/agentsLive.ts'
import type { StoredMetric, Task as StoredTask, TaskSel } from '../main/tasks.ts'
export type { Catalog, ModelOpt, SendResult }

const changedLists: Record<string, string[]> = {
  addPermissionRule: ['listPermissionRules', 'listPermissionRequests'],
  removePermissionRule: ['listPermissionRules', 'listPermissionRequests'],
  resolvePermissionRequest: ['listPermissionRules', 'listPermissionRequests'],
  hideGame: ['listHidden'], unhideGame: ['listHidden']
}
// Contratos dos canais mais usados (formatos do processo principal); os demais continuam sem tipo.
type Api = {
  [name: string]: (...a: any[]) => Promise<any>
  listGames(): Promise<string[]>
  listAccounts(): Promise<Account[]>
  listActive(): Promise<Active[]>
  taskAgents(id: number): Promise<TaskAgent[]>
  listTasks(game: string, o: { search?: string; archived?: boolean }): Promise<Task[]>
  createTask(game: string, title?: string): Promise<number>
  taskChat(id: number, sel: Sel): Promise<TaskChat>
  sendTask(id: number, sel: Sel, text: string, images?: string[], stepId?: number): Promise<SendResult>
  setTaskSel(id: number, sel: Sel): Promise<void>
  stopTask(id: number): Promise<void>
  catalog(provider: string, force?: boolean): Promise<Catalog>
}
export const api = new Proxy({} as Api, {
  get: (_t, name: string) => (...args: any[]) => {
    const read = SETTINGS_READS[name] // o main devolve em cada setter o formato da leitura
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
export type Task = StoredTask & {
  state: 'aberta' | 'andamento' | 'concluida'
  messages?: number; running?: boolean
  sel?: string | null // JSON da escolha de provedor/perfil/modelo/esforco da tarefa
}
export type Msg = {
  id: number; role: 'user' | 'agent' | 'system'; text: string; status?: 'completed' | 'failed' | 'cancelled' | null
  provider?: string | null; account_id?: number | null; model?: string | null; effort?: string | null; created_at: string
}
export type Sel = TaskSel
export type Metric = StoredMetric
// Conversa da tarefa (IPC taskChat).
export type TaskChat = {
  task: Task; running: boolean; awaitingContext: boolean; live: string; session: string | null; sessions: { provider: string; profile: string }[]
  sel: Sel | null; metric: Metric | null; messages: Msg[]
}

// Eventos de streaming do chat: { taskId, text } enquanto executa e { taskId, done } ao terminar.
const listeners = new Set<(ev: any) => void>()
const offBridge: (() => void) | undefined = (window as any).onChat?.((ev: any) => {
  if (Number.isSafeInteger(ev.accountUsage?.accountId)) {
    const key = `accountUsage:${ev.accountUsage.accountId}`
    if (ev.accountUsage.usage === null) {
      invalidateRead(key)
      invalidateRead(`accountStatus:${ev.accountUsage.accountId}`)
    } else setRead(key, ev.accountUsage.usage)
  }
  // Um listener com erro nao impede a entrega aos outros.
  for (const f of listeners) try { f(ev) } catch (e) { console.error(e) }
})
import.meta.hot?.dispose(() => offBridge?.()) // HMR recarrega este modulo: sem isso os listeners da ponte se acumulam
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

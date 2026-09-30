// Snapshots de configuracoes e quotas; historico/contexto de tarefas nao entra neste cache.
export type ReadSnapshot<T> = { data: T | undefined; error: unknown }
type Entry = {
  snapshot: ReadSnapshot<unknown>; at?: number; generation: number
  pending?: Promise<unknown>; listeners: Set<() => void>
}
const entries = new Map<string, Entry>()
const entryFor = (key: string) => {
  let entry = entries.get(key)
  if (!entry) {
    entry = { snapshot: { data: undefined, error: undefined }, generation: 0, listeners: new Set() }
    entries.set(key, entry)
  }
  return entry
}
const notify = (entry: Entry) => entry.listeners.forEach(f => f())

export const readSnapshot = <T>(key: string) => entryFor(key).snapshot as ReadSnapshot<T>
export const peekRead = <T>(key: string) => readSnapshot<T>(key).data
export function subscribeRead(key: string, listener: () => void) {
  const entry = entryFor(key)
  entry.listeners.add(listener)
  return () => { entry.listeners.delete(listener) }
}
export function setRead<T>(key: string, data: T) {
  const entry = entryFor(key)
  entry.generation++
  entry.pending = undefined
  entry.at = Date.now()
  entry.snapshot = { data, error: undefined }
  notify(entry)
}
export function invalidateRead(key: string) {
  const entry = entryFor(key)
  entry.generation++
  entry.pending = undefined
  entry.at = undefined
  entry.snapshot = { data: undefined, error: undefined }
  notify(entry)
}
export function expireRead(key: string) {
  const entry = entryFor(key)
  entry.generation++
  entry.pending = undefined
  entry.at = undefined
}

// Uma consulta por chave; refresh preserva o valor e uma resposta antiga nao substitui uma gravacao mais nova.
export function loadRead<T>(key: string, loader: () => Promise<T>, ttl = 0): Promise<T> {
  const entry = entryFor(key)
  if (entry.pending) return entry.pending as Promise<T>
  const age = entry.at === undefined ? Infinity : Date.now() - entry.at
  if (ttl > 0 && age >= 0 && age < ttl && entry.snapshot.data !== undefined) return Promise.resolve(entry.snapshot.data as T)
  const generation = entry.generation
  const pending = Promise.resolve().then(loader).then(data => {
    if (entry.generation === generation) {
      entry.at = Date.now()
      entry.snapshot = { data, error: undefined }
      notify(entry)
    }
    return data
  }, error => {
    if (entry.generation === generation) {
      entry.snapshot = { data: entry.snapshot.data, error }
      notify(entry)
    }
    throw error
  }).finally(() => { if (entry.pending === pending) entry.pending = undefined })
  entry.pending = pending
  return pending
}

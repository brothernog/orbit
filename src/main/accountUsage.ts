// Limites da assinatura: o ultimo valor conhecido aparece antes da consulta opcional.
import { sanitize } from './providers.ts'

export type UsageWindow = { utilization: number; resets_at: string | null }
export type AccountUsage = { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; seenAt?: string; cached?: true; refreshError?: string }
type UsageDeps = {
  identity: (id: number) => string | null
  read: (id: number, identity: string) => unknown
  write: (id: number, identity: string, usage: AccountUsage) => void
  clear: (id: number) => void
  request: (id: number, signal: AbortSignal) => Promise<unknown>
  emit: (id: number, usage: AccountUsage | null) => void
  refreshGuard?: (work: () => Promise<AccountUsage>) => Promise<AccountUsage>
  now?: () => number
}
export const USAGE_TTL = 25_000 // abaixo do intervalo de 30 s de Configuracoes e do planeta: seenAt chega depois do pedido e nao pode pular uma rodada
const TTL = USAGE_TTL
const windowOf = (value: any): UsageWindow | null => value && typeof value.utilization === 'number' && Number.isFinite(value.utilization) && value.utilization >= 0
  ? { utilization: value.utilization, resets_at: typeof value.resets_at === 'string' && Number.isFinite(Date.parse(value.resets_at)) ? value.resets_at : null } : null
export function usageSnapshot(value: any): AccountUsage | null {
  if (!value || typeof value !== 'object' || !('fiveHour' in value || 'sevenDay' in value)) return null
  return { fiveHour: windowOf(value.fiveHour), sevenDay: windowOf(value.sevenDay), ...(typeof value.seenAt === 'string' && Number.isFinite(Date.parse(value.seenAt)) ? { seenAt: value.seenAt } : {}) }
}

export function createAccountUsageService(d: UsageDeps) {
  const now = d.now ?? Date.now
  type Entry = { identity: string; revision: number; attemptedAt?: number; pending?: Promise<AccountUsage>; error?: string }
  const entries = new Map<number, Entry>()
  const entryFor = (id: number) => {
    const identity = d.identity(id)
    if (!identity) return null
    let entry = entries.get(id)
    if (entry && entry.identity !== identity) { entries.delete(id); d.clear(id); entry = undefined }
    if (!entry) { entry = { identity, revision: 0 }; entries.set(id, entry) }
    return entry
  }
  const current = (id: number, entry: Entry) => entries.get(id) === entry && d.identity(id) === entry.identity
  const cached = (id: number, entry: Entry) => {
    const usage = usageSnapshot(d.read(id, entry.identity))
    return usage && { ...usage, cached: true as const, ...(entry.error ? { refreshError: entry.error } : {}) }
  }
  const save = (id: number, entry: Entry, raw: unknown) => {
    if (!current(id, entry)) throw Error('A conta mudou durante a consulta de uso.')
    const usage = usageSnapshot(raw)
    if (!usage) throw Error('Consulta de uso sem dados reconhecidos.')
    const snapshot = { ...usage, seenAt: new Date(now()).toISOString() }
    entry.error = undefined
    d.write(id, entry.identity, snapshot)
    entry.revision++
    d.emit(id, snapshot)
    return snapshot
  }
  const refresh = (id: number, entry: Entry) => {
    entry.attemptedAt = now()
    entry.error = undefined
    const revision = entry.revision
    const newer = () => entry.revision !== revision && current(id, entry) ? cached(id, entry) : null
    const work = async () => {
      const raw = await d.request(id, AbortSignal.timeout(10_000))
      return newer() ?? save(id, entry, raw)
    }
    const pending = (d.refreshGuard ? d.refreshGuard(work) : work()).catch(error => {
      if (!current(id, entry)) throw Error('A conta mudou durante a consulta de uso.')
      const latest = newer()
      if (latest) return latest
      entry.error = sanitize(error instanceof Error ? error.message : String(error)).slice(0, 300)
      const usage = cached(id, entry)
      if (usage) { d.emit(id, usage); return usage }
      throw Error(entry.error)
    }).finally(() => { if (entry.pending === pending) entry.pending = undefined })
    entry.pending = pending
    return pending
  }
  return {
    snapshot(id: number): AccountUsage | null {
      const entry = entryFor(id)
      return entry && cached(id, entry)
    },
    get(id: number): Promise<AccountUsage> {
      const entry = entryFor(id)
      if (!entry) return Promise.reject(Error('Conta indisponivel para consultar uso. Aguarde a conclusao do login.'))
      const usage = cached(id, entry), at = now(), seenAt = Date.parse(usage?.seenAt ?? '')
      const fresh = at >= seenAt && at - seenAt < TTL
      if (!fresh && !entry.pending && (entry.attemptedAt === undefined || at < entry.attemptedAt || at - entry.attemptedAt >= TTL)) refresh(id, entry)
      if (usage) { entry.pending?.catch(() => {}); return Promise.resolve(usage) }
      return entry.pending ?? Promise.reject(Error(entry.error ?? 'Uso indisponivel.'))
    },
    writer(id: number): (usage: unknown) => void {
      const entry = entryFor(id)
      return usage => { if (entry && current(id, entry)) save(id, entry, usage) }
    },
    invalidate(id: number) {
      entries.delete(id)
      d.clear(id)
      d.emit(id, null)
    }
  }
}

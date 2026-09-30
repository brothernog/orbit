// Texto honesto para totais de uso: ausencia nunca vira zero e soma parcial nunca se apresenta como consumo completo.
// Mesmos estados do processo principal (usage.ts): complete | partial | unavailable.
export type Cover = 'complete' | 'partial' | 'unavailable'
export type TotalLike = { sum: number | null; state: Cover; estimated?: boolean }
export type UsageWindow = { utilization: number; resets_at: string | null } | null
export type QuotaSnapshot = {
  fiveHour?: UsageWindow; sevenDay?: UsageWindow; seenAt?: string | null
  cached?: boolean; error?: string; refreshError?: string; expired?: boolean
}

export function usageNote(u: QuotaSnapshot | null | undefined, source: 'claude' | 'codex' = 'claude', now = Date.now()) {
  if (!u) return ''
  const minutes = u.seenAt ? Math.max(0, Math.round((now - Date.parse(u.seenAt)) / 60000)) : NaN
  const age = !Number.isFinite(minutes) ? '' : minutes < 2 ? 'agora' : minutes < 90 ? `há ${minutes} min`
    : minutes < 2160 ? `há ${Math.round(minutes / 60)} h` : `há ${Math.round(minutes / 1440)} d`
  const label = source === 'codex' ? 'Do último uso do Codex' : u.cached ? 'Último valor visto' : 'Atualizado'
  if (!age && !u.cached) return ''
  return `${label}${age ? ` ${age}` : ' (data indisponível)'}${u.refreshError ? ' (consulta indisponível agora)' : ''}.`
}

export const compact = (n: number | null | undefined) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(n))

// "—" sem dado; "≥ 12 mil" quando so parte dos registros informou (total conhecido, nao o consumo completo); "(est.)" quando ha estimativa.
export const totalText = (t: TotalLike | null | undefined) => {
  if (!t || t.sum === null || t.state === 'unavailable') return '—'
  return `${t.state === 'partial' ? '≥ ' : ''}${compact(t.sum)}${t.estimated ? ' (est.)' : ''}`
}
export const coverTitle = (t: TotalLike | null | undefined) =>
  !t || t.state === 'unavailable' ? 'O provedor não informou este valor: não é zero.'
    : t.state === 'partial' ? 'Total conhecido (parcial): parte das execuções não informou este valor, então o consumo real é maior ou igual a este.'
    : t.estimated ? 'Valor estimado, não informado pelo provedor.' : 'Todas as execuções informaram este valor.'

// Renovacao de um limite, como no Claude Desktop: nas proximas 24 h conta o tempo ("Reinicia em 4 h 16 min"); depois, dia e hora.
export const resetText = (iso: string | null, now = Date.now()) => {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'Reiniciando'
  if (ms < 864e5) { const m = Math.ceil(ms / 6e4), h = Math.floor(m / 60); return `Reinicia em ${h ? `${h} h ` : ''}${m % 60} min` }
  return `Reinicia ${new Date(iso).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}

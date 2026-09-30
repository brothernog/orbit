// Contexto ocupado do Codex a partir do arquivo de sessao (rollout) que a propria CLI grava.
// `codex exec --json` nao informa a janela; o arquivo traz eventos token_count com last_token_usage e
// model_context_window. Formato NAO documentado: qualquer divergencia resulta em "indisponivel", nunca em numero inventado.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Metric } from './adapters.ts'

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

// Arquivo da sessao: sessions/AAAA/MM/DD/rollout-<data>-<threadId>.jsonl (procura do dia mais recente para o mais antigo).
// Achado: guardado enquanto o arquivo existir. Ausente: a varredura de todos os dias so se repete quando a pasta do dia mais
// recente muda (arquivo novo ou dia novo), que e onde um rollout novo aparece.
const found = new Map<string, string>(), missing = new Map<string, string>()
const desc = (dir: string) => { try { return fs.readdirSync(dir).sort().reverse() } catch { return [] } }
function newestDay(root: string): string {
  const y = desc(root)[0], m = y && desc(path.join(root, y))[0], d = m && desc(path.join(root, y, m))[0]
  if (!d) return ''
  const dir = path.join(root, y, m, d)
  try { return `${dir}|${fs.statSync(dir).mtimeMs}` } catch { return '' }
}
export function findRollout(threadId: string, home = codexHome()): string | null {
  if (!/^[\w-]{8,64}$/.test(threadId)) return null
  const key = `${home}\0${threadId}`, hit = found.get(key)
  if (hit && fs.existsSync(hit)) return hit
  const root = path.join(home, 'sessions'), stamp = newestDay(root)
  if (missing.get(key) === stamp) return null
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d)
    const f = desc(dir).find(n => n.endsWith(`${threadId}.jsonl`))
    if (f) { found.set(key, path.join(dir, f)); missing.delete(key); return path.join(dir, f) }
  }
  if (missing.size > 200) missing.clear()
  missing.set(key, stamp)
  return null
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

// Final do arquivo (os eventos mais recentes); null se nao der para ler.
function tail(file: string, max = 512 * 1024): string | null {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(size, max)
      const b = Buffer.alloc(len)
      fs.readSync(fd, b, 0, len, size - len)
      return b.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

// Ultimo token_count do arquivo (le so o final). Contexto ocupado = tokens da ULTIMA chamada sem o raciocinio oculto.
export function codexContextFromRollout(file: string): Metric | null {
  const buf = tail(file)
  if (buf == null) return null
  const lines = buf.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('token_count')) continue
    let j: any
    try { j = JSON.parse(lines[i]) } catch { continue }
    const p = j.payload ?? j
    if (p?.type !== 'token_count' || !p.info) continue
    const last = p.info.last_token_usage
    const total = n(last?.total_tokens)
    if (total === undefined) continue
    return { occupied: total - (n(last.reasoning_output_tokens) ?? 0), capacity: n(p.info.model_context_window), estimated: true, source: 'arquivo de sessao do Codex (token_count; formato nao documentado)' }
  }
  return null
}

// Rollouts mais recentes primeiro (o nome comeca com a data e hora da sessao).
function recentRollouts(home: string, limit: number): string[] {
  const root = path.join(home, 'sessions'), out: string[] = []
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    for (const f of desc(path.join(root, y, m, d))) if (f.endsWith('.jsonl')) { out.push(path.join(root, y, m, d, f)); if (out.length >= limit) return out }
  }
  return out
}

export type LimitWindow = { utilization: number; resets_at: string }
export type CodexLimits = { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; seenAt: string | null; expired: boolean }

// Limites do Codex (5 h e semanal) pelo rate_limits que a propria CLI grava nas sessoes: so leitura local, sem rede e sem tokens.
// O valor e o do ULTIMO uso do Codex; janela ja reiniciada vira null (expired), nunca 0 inventado. Formato nao documentado.
// Ultimo evento rate_limits de cada rollout, guardado por tamanho/mtime (o arquivo so muda enquanto a sessao roda). So o evento
// bruto fica em cache: expiracao e janelas sao recalculadas com o `now` de cada chamada.
type LimitEvent = { rl: any; seen: number }
const limitEvents = new Map<string, { size: number; mtimeMs: number; event: LimitEvent | null }>()
function lastLimitEvent(file: string): LimitEvent | null {
  let st: fs.Stats
  try { st = fs.statSync(file) } catch { return null }
  const c = limitEvents.get(file)
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.event
  const buf = tail(file)
  if (buf == null) return null // falha de leitura nao fica em cache
  let event: LimitEvent | null = null
  const lines = buf.split('\n')
  for (let i = lines.length - 1; i >= 0 && !event; i--) {
    if (!lines[i].includes('"rate_limits"')) continue
    let j: any
    try { j = JSON.parse(lines[i]) } catch { continue }
    const rl = (j.payload ?? j)?.rate_limits
    if (rl && typeof rl === 'object') event = { rl, seen: Date.parse(j.timestamp) }
  }
  if (limitEvents.size > 50) limitEvents.clear()
  limitEvents.set(file, { size: st.size, mtimeMs: st.mtimeMs, event })
  return event
}
export function codexLimits(home = codexHome(), now = Date.now()): CodexLimits | null {
  for (const file of recentRollouts(home, 5)) {
    const e = lastLimitEvent(file)
    if (e) {
      const { rl, seen } = e
      const out: CodexLimits = { fiveHour: null, sevenDay: null, seenAt: Number.isFinite(seen) ? new Date(seen).toISOString() : null, expired: false }
      for (const w of [rl.primary, rl.secondary]) {
        const used = n(w?.used_percent), mins = n(w?.window_minutes)
        if (used === undefined || mins === undefined) continue
        // versoes novas gravam resets_at (epoch em s); antigas, resets_in_seconds relativo ao evento
        const reset = n(w.resets_at) !== undefined ? w.resets_at * 1000 : n(w.resets_in_seconds) !== undefined && Number.isFinite(seen) ? seen + w.resets_in_seconds * 1000 : NaN
        if (!Number.isFinite(reset)) continue
        if (reset <= now) { out.expired = true; continue }
        const win = { utilization: used, resets_at: new Date(reset).toISOString() }
        if (mins <= 24 * 60) out.fiveHour = win; else out.sevenDay = win
      }
      return out
    }
  }
  return null
}

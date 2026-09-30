// Contexto ocupado do Codex a partir do arquivo de sessao (rollout) que a propria CLI grava.
// `codex exec --json` nao informa a janela; o arquivo traz eventos token_count com last_token_usage e
// model_context_window. Formato NAO documentado: qualquer divergencia resulta em "indisponivel", nunca em numero inventado.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Metric } from './adapters.ts'

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

// Arquivo da sessao: sessions/AAAA/MM/DD/rollout-<data>-<threadId>.jsonl (procura do dia mais recente para o mais antigo).
export function findRollout(threadId: string, home = codexHome()): string | null {
  if (!/^[\w-]{8,64}$/.test(threadId)) return null
  const desc = (dir: string) => { try { return fs.readdirSync(dir).sort().reverse() } catch { return [] } }
  const root = path.join(home, 'sessions')
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d)
    const f = desc(dir).find(n => n.endsWith(`${threadId}.jsonl`))
    if (f) return path.join(dir, f)
  }
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
  const desc = (dir: string) => { try { return fs.readdirSync(dir).sort().reverse() } catch { return [] } }
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
export function codexLimits(home = codexHome(), now = Date.now()): CodexLimits | null {
  for (const file of recentRollouts(home, 5)) {
    const lines = (tail(file) ?? '').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue
      let j: any
      try { j = JSON.parse(lines[i]) } catch { continue }
      const rl = (j.payload ?? j)?.rate_limits
      if (!rl || typeof rl !== 'object') continue
      const seen = Date.parse(j.timestamp)
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

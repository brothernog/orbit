// Pulso das pastas onde ha agente trabalhando: cada rodada de gravacoes vira um evento com quantas linhas mudaram (delta do git)
// e quem trabalhava. So a ultima hora, em memoria. Sem IA, sem tokens, sem dependencia de 'electron'.

export type PulseEvent = { t: number; v: number; provider: string | null; del: boolean }
export type Tracked = { dir: string; game: string; provider: string | null }
export type Totals = Map<string, { a: number; r: number }> // arquivo -> linhas adicionadas/removidas sem commit

const HOUR = 3600_000

// Mudanca entre duas leituras. Arquivo que saiu da lista (commit ou reversao) nao conta como apagado.
// del = mais linhas saindo (removidas novas ou adicoes desfeitas) do que entrando.
export function delta(prev: Totals, cur: Totals) {
  let up = 0, down = 0
  for (const [f, c] of cur) {
    const p = prev.get(f) ?? { a: 0, r: 0 }
    const da = c.a - p.a, dr = c.r - p.r
    up += Math.max(0, da) + Math.max(0, -dr)
    down += Math.max(0, dr) + Math.max(0, -da)
  }
  return { v: up + down, del: down > up }
}

export function createPulse(o: {
  watch: (dir: string, onWrite: () => void) => () => void
  sample: (dir: string) => Promise<Totals>
  onEvent?: (game: string) => void
  now?: () => number
  settleMs?: number
}) {
  const now = o.now ?? Date.now
  const dirs = new Map<string, { t: Tracked; off: () => void; base: Totals | null; timer?: ReturnType<typeof setTimeout> }>()
  const events = new Map<string, PulseEvent[]>() // por projeto

  // Uma leitura por pasta de cada vez: duas em paralelo podiam terminar fora de ordem e deixar a base mais antiga por ultimo.
  // Gravacoes durante a leitura pedem uma nova rodada ao terminar.
  const running = new Set<string>(), again = new Set<string>()
  const measure = async (key: string): Promise<void> => {
    if (running.has(key)) { again.add(key); return }
    running.add(key)
    try { await measureOnce(key) } finally { running.delete(key) }
    if (again.delete(key)) return measure(key)
  }
  const measureOnce = async (key: string) => {
    const d = dirs.get(key)
    if (!d) return
    let cur: Totals
    try { cur = await o.sample(d.t.dir) } catch { return }
    if (d.base) {
      const { v, del } = delta(d.base, cur)
      if (v > 0) {
        const list = (events.get(d.t.game) ?? []).filter(e => now() - e.t < HOUR)
        list.push({ t: now(), v, provider: d.t.provider, del })
        events.set(d.t.game, list)
        o.onEvent?.(d.t.game)
      }
    }
    d.base = cur
  }

  return {
    // Chamado periodicamente com as pastas que tem agente agora: entra quem chegou, sai quem terminou (os eventos ficam).
    track(list: Tracked[]) {
      const want = new Map(list.map(t => [t.dir.toLowerCase(), t]))
      for (const [k, d] of dirs) if (!want.has(k)) { d.off(); clearTimeout(d.timer); dirs.delete(k) }
      for (const [k, t] of want) {
        const d = dirs.get(k)
        if (d) { d.t = t; continue }
        const entry = { t, base: null as Totals | null, off: () => {}, timer: undefined as ReturnType<typeof setTimeout> | undefined }
        dirs.set(k, entry)
        measure(k) // linha de base: o que ja estava sujo antes nao vira pico
        entry.off = o.watch(t.dir, () => { clearTimeout(entry.timer); entry.timer = setTimeout(() => measure(k), o.settleMs ?? 1500) })
      }
    },
    events(): Record<string, PulseEvent[]> {
      const out: Record<string, PulseEvent[]> = {}
      for (const [g, l] of events) { const f = l.filter(e => now() - e.t < HOUR); if (f.length) out[g] = f }
      return out
    },
    stop() { for (const d of dirs.values()) { d.off(); clearTimeout(d.timer) } dirs.clear() },
  }
}

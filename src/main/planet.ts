import type { DatabaseSync } from 'node:sqlite'

// Planeta da area de trabalho: o uso de cada conta em uso, alternando entre elas. A janela de 5 h vai no planeta (e a que mais
// se move); a semanal so entra quando nao ha 5 h viva e segue junto para a dica. Janela ja reiniciada (resets_at no passado)
// nao conta: o valor visto era de antes do reinicio e nao vira 0 inventado.

export type LimitWindow = { utilization: number; resets_at: string | null }
export type LimitRow = { fiveHour?: LimitWindow | null; sevenDay?: LimitWindow | null } | null | undefined
export type PlanetUsage = { source: string; pct?: number; window?: '5h' | 'semana'; resetsAt?: string; week?: number }

export function planetUsage(source: string, row: LimitRow, now = Date.now()): PlanetUsage {
  const live = (w?: LimitWindow | null) => (w && w.resets_at && Number.isFinite(w.utilization) && Date.parse(w.resets_at) > now ? { ...w, resets_at: w.resets_at } : null)
  const h5 = live(row?.fiveHour), wk = live(row?.sevenDay)
  const main = h5 ?? wk
  return {
    source,
    ...(main && { pct: main.utilization, window: h5 ? '5h' as const : 'semana' as const, resetsAt: main.resets_at }),
    ...(h5 && wk && { week: wk.utilization })
  }
}

// Contas "em uso": as que tem execucao ou delegacao rodando agora. Sem nada rodando, a da execucao mais recente.
// So Claude (por conta) e Codex informam limite; os outros provedores ficam de fora.
export type InUse = { provider: 'claude'; accountId: number } | { provider: 'codex' }
export function inUse(db: DatabaseSync): InUse[] {
  const pick = (rows: { provider: string; account_id: number | null }[]) => {
    const out: InUse[] = [], seen = new Set<string>()
    for (const r of rows) {
      const u: InUse | null = r.provider === 'codex' ? { provider: 'codex' } : r.provider === 'claude' && r.account_id != null ? { provider: 'claude', accountId: r.account_id } : null
      const k = u && JSON.stringify(u)
      if (u && !seen.has(k!)) { seen.add(k!); out.push(u) }
    }
    return out
  }
  const running = pick(db.prepare(`SELECT provider, account_id FROM runs WHERE status='running'
    UNION ALL SELECT provider, account_id FROM delegations WHERE status='running'`).all() as any[])
  if (running.length) return running
  return pick(db.prepare(`SELECT provider, account_id FROM runs WHERE provider IN ('claude','codex') ORDER BY id DESC LIMIT 1`).all() as any[])
}

// Onde fica a janela do planeta. `pos` = canto superior esquerdo do quadrado do planeta; `wa` = area util da tela dele.
// O aviso cresce na direcao do centro da tela (planeta na metade direita abre para a esquerda, na de baixo abre para cima),
// com o planeta parado no mesmo ponto; a altura fica limitada ao espaco ate a borda.
export type Rect = { x: number; y: number; width: number; height: number }
export function planetLayout(pos: { x: number; y: number }, wa: Rect, size: number, notice?: { width: number; height: number }) {
  const right = pos.x + size / 2 > wa.x + wa.width / 2, bottom = pos.y + size / 2 > wa.y + wa.height / 2
  if (!notice) return { right, bottom, bounds: { x: pos.x, y: pos.y, width: size, height: size } }
  const room = bottom ? pos.y + size - wa.y : wa.y + wa.height - pos.y
  const h = Math.max(size, Math.min(Math.ceil(notice.height), room))
  return { right, bottom, bounds: { x: right ? pos.x + size - notice.width : pos.x, y: bottom ? pos.y + size - h : pos.y, width: notice.width, height: h } }
}

// Luas do planeta: todo agente trabalhando agora, direto numa tarefa (runs) ou delegado por outro agente (delegacoes, rodando ou
// esperando aprovacao de contexto), do mais antigo para o mais novo. `key` distingue as duas tabelas (os ids se repetem).
export type Moon = { key: string; slot: number; provider: string; delegated: boolean; waiting: boolean; title: string }
export function moons(db: DatabaseSync): Moon[] {
  const runs = db.prepare(`SELECT r.id, r.provider, COALESCE(t.title, '') title FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
    WHERE r.status = 'running' ORDER BY r.id`).all() as any[]
  const dels = db.prepare(`SELECT d.id, d.provider, d.status, COALESCE(NULLIF(d.objective, ''), t.title, '') title FROM delegations d
    LEFT JOIN tasks t ON t.id = d.task_id WHERE d.status IN ('running', 'awaiting_context_approval') ORDER BY d.id`).all() as any[]
  return [
    ...runs.map(r => ({ key: `r${r.id}`, slot: r.id, provider: r.provider ?? '', delegated: false, waiting: false, title: r.title })),
    ...dels.map(d => ({ key: `d${d.id}`, slot: d.id * 3 + 1, provider: d.provider, delegated: true, waiting: d.status === 'awaiting_context_approval', title: d.title }))
  ]
}

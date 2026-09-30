// Automacoes: regras "gatilho -> acao" avaliadas por software (sem IA) antes de cada envio do usuario. Nenhuma regra envia nada sozinha
// nem move contexto: trocar de conta so muda o destino; historico para o novo perfil continua passando pelo pedido de consentimento.
import type { AccountUsage } from './accountUsage.ts'
import type { TaskSel } from './tasks.ts'

export type Trigger = { kind: 'usage_above'; percent: number }
export type Action = { kind: 'switch_account'; order: number[] }
export type Rule = { id: string; enabled: boolean; when: Trigger; then: Action }
export type SendCtx = {
  sel: TaskSel
  usage: (accountId: number) => AccountUsage | null // ultimo valor conhecido (sem rede)
  peers: (accountId: number) => number[] // outras contas Claude com login proprio, na ordem de cadastro
  accountName: (accountId: number) => string
  now: number
}

// Maior uso entre as janelas ainda vigentes; janela ja reiniciada nao conta. null = desconhecido.
export function usedPercent(u: AccountUsage | null, now: number): number | null {
  const live = [u?.fiveHour, u?.sevenDay].filter(w => w && !(w.resets_at && Date.parse(w.resets_at) <= now)) as { utilization: number }[]
  return live.length ? Math.max(...live.map(w => w.utilization)) : null
}

const TRIGGERS: { [K in Trigger['kind']]: (t: Extract<Trigger, { kind: K }>, c: SendCtx) => boolean } = {
  usage_above: (t, c) => c.sel.provider === 'claude' && !!c.sel.accountId && (usedPercent(c.usage(c.sel.accountId), c.now) ?? -1) >= t.percent
}
// Acao devolve a nova selecao (ou null se nao ha para onde ir) e o aviso mostrado na conversa.
const ACTIONS: { [K in Action['kind']]: (a: Extract<Action, { kind: K }>, r: Rule, c: SendCtx) => { sel: TaskSel; note: string } | null } = {
  switch_account: (a, r, c) => {
    const from = c.sel.accountId!, peers = c.peers(from)
    const order = [...a.order.filter(id => peers.includes(id)), ...peers.filter(id => !a.order.includes(id))]
    // candidato = conta onde o mesmo gatilho NAO dispararia (uso desconhecido conta como disponivel)
    const to = order.find(id => !fires(r.when, { ...c, sel: { ...c.sel, accountId: id } }))
    if (to == null) return null
    const pct = usedPercent(c.usage(from), c.now)
    return { sel: { ...c.sel, accountId: to }, note: `↳ Automacao: ${c.accountName(from)} em ${Math.round(pct ?? 0)}% do limite; mensagem enviada por ${c.accountName(to)}. O historico so segue para a nova conta se voce aprovar o contexto.` }
  }
}
const fires = (t: Trigger, c: SendCtx) => TRIGGERS[t.kind](t as any, c)

export function applyBeforeSend(rules: Rule[], c: SendCtx): { sel: TaskSel; notes: string[] } {
  let sel = c.sel
  const notes: string[] = []
  for (const r of rules) {
    if (!r.enabled || !fires(r.when, { ...c, sel })) continue
    const out = ACTIONS[r.then.kind](r.then as any, r, { ...c, sel })
    if (out) { sel = out.sel; notes.push(out.note) }
    else notes.push(`↳ Automacao: limite de ${r.when.percent}% atingido, mas nenhuma outra conta tem uso disponivel. Mensagem enviada pela conta atual.`)
  }
  return { sel, notes }
}

// Composicao: regras guardadas em settings (chave 'automations'); o index so liga as dependencias.
export function createAutomations(d: { getSetting: (k: string) => string | undefined; setSetting: (k: string, v: string) => unknown } & Omit<SendCtx, 'sel' | 'now'>) {
  const rules = () => { try { return normalizeRules(JSON.parse(d.getSetting('automations') ?? '[]')) } catch { return [] } }
  return {
    rules, peers: d.peers,
    setRules: (raw: unknown) => { const n = normalizeRules(raw); d.setSetting('automations', JSON.stringify(n)); return n },
    beforeSend: (sel: TaskSel) => applyBeforeSend(rules(), { ...d, sel, now: Date.now() })
  }
}

// Valida o que vem da interface/banco: regra desconhecida ou malformada e descartada.
export function normalizeRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 20).flatMap((r: any): Rule[] => {
    const w = r?.when, t = r?.then
    if (typeof r?.id !== 'string' || !/^[\w-]{1,40}$/.test(r.id)) return []
    if (w?.kind !== 'usage_above' || !Number.isFinite(w.percent)) return []
    if (t?.kind !== 'switch_account') return []
    const order = Array.isArray(t.order) ? t.order.filter((n: unknown) => Number.isInteger(n) && (n as number) > 0).slice(0, 50) : []
    return [{ id: r.id, enabled: r.enabled === true, when: { kind: 'usage_above', percent: Math.min(100, Math.max(1, Math.round(w.percent))) }, then: { kind: 'switch_account', order } }]
  })
}

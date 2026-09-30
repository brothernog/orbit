// Permissoes dos agentes do dashboard: pedidos (pendente, permitido uma vez, sempre permitido, negado), regras persistidas por agente
// e por comando exato ou prefixo ("npm run *"), e a protecao contra regras amplas/destrutivas. O Claude pergunta pelo pop-up via a
// ferramenta MCP `permission_prompt` (--permission-prompt-tool); Codex e OpenCode nao tem prompt interativo no modo headless, entao
// "sempre permitir" vira a politica nativa deles (sandbox/--auto), ver nativePolicy. Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'
import type { ChatOpts } from './adapters.ts'
import type { ToolDef } from './mcp.ts'

const get = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any
const all = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]
const NOW = "strftime('%Y-%m-%d %H:%M:%f','now')"

// ---- Configuracoes (Configuracoes > Permissoes)
export type PermissionSettings = {
  prompt: boolean // Claude: perguntar pelo pop-up (falso = comportamento antigo: o que exigiria permissao e negado)
  timeoutMin: number // espera pela resposta; sem resposta = negado
  codexSandbox: 'workspace-write' | 'danger-full-access' // "sempre permitir" do Codex: sem sandbox (exige ciencia do risco)
  codexNetwork: boolean // rede dentro da sandbox workspace-write
  opencodeAuto: boolean // OpenCode --auto: aprova tudo que nao esteja explicitamente negado
  claudeAuto: boolean // Claude --permission-mode auto: o classificador da CLI aprova o que e seguro (so em edicao)
}
export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = { prompt: true, timeoutMin: 5, codexSandbox: 'workspace-write', codexNetwork: false, opencodeAuto: false, claudeAuto: false }
export function normalizePermissionSettings(raw: any): PermissionSettings {
  const d = DEFAULT_PERMISSION_SETTINGS
  const t = Number(raw?.timeoutMin)
  return {
    prompt: raw?.prompt === undefined ? d.prompt : raw.prompt === true,
    timeoutMin: Number.isFinite(t) ? Math.min(60, Math.max(1, Math.round(t))) : d.timeoutMin,
    codexSandbox: raw?.codexSandbox === 'danger-full-access' ? 'danger-full-access' : 'workspace-write',
    codexNetwork: raw?.codexNetwork === true, opencodeAuto: raw?.opencodeAuto === true, claudeAuto: raw?.claudeAuto === true
  }
}

// ---- Comandos: casamento seguro
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
export type Subject = { kind: 'bash' | 'tool'; subject: string; command?: string }
export function subjectOf(tool: string, input: any): Subject {
  if (SHELL_TOOLS.has(tool) && typeof input?.command === 'string') return { kind: 'bash', subject: input.command.trim(), command: input.command.trim() }
  return { kind: 'tool', subject: tool }
}
const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')
// Comando "simples": sem encadeamento, pipe, redirecionamento, substituicao, expansao nem quebra de linha. So estes casam com regra de PREFIXO:
// `npm run *` nunca libera `npm run x && rm -rf /`.
export const isSimple = (cmd: string) => !/[;&|<>`\r\n^%]|\$\(|\$\{|\$[A-Za-z_]/.test(cmd)

export function matches(kind: 'bash' | 'tool', pattern: string, subject: string): boolean {
  if (kind === 'tool') return pattern.endsWith('*') ? subject.startsWith(pattern.slice(0, -1)) : subject === pattern
  const cmd = collapse(subject), pat = collapse(pattern)
  if (pat !== '*' && !pat.endsWith(' *')) return cmd === pat // exato (o comando inteiro, qualquer que seja)
  if (!isSimple(subject)) return false // no texto ORIGINAL: colapsar espacos apagaria as quebras de linha
  const prefix = pat === '*' ? '' : pat.slice(0, -2).toLowerCase()
  const low = cmd.toLowerCase()
  return prefix === '' || low === prefix || low.startsWith(prefix + ' ')
}

// ---- Risco
const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(-\w*[rRfF]|--recursive|--force)/i, /\b(del|erase)\b.*\/[sSqQ]/i, /\brmdir\b.*\/s/i, /\brd\b.*\/s/i, /\bRemove-Item\b/i, /\bformat\s+[a-z]:/i, /\bmkfs\b/i, /\bdd\s+.*\bof=/i,
  /\bshutdown\b/i, /\breboot\b/i, /\bgit\s+(reset\s+--hard|clean\b|push\b.*(--force|-f\b|--delete)|checkout\s+--|restore\b|branch\s+-D|stash\s+(drop|clear))/i,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|iex|Invoke-Expression|powershell|pwsh)/i, /\b(iex|Invoke-Expression)\b/i,
  /\breg\s+delete\b/i, /\btaskkill\b/i, /\bchmod\s+-R\s+7/i, /\bsudo\b/i, /\bnpm\s+(publish|unpublish)\b/i, /\bdrop\s+(table|database)\b/i, /\bSet-ExecutionPolicy\b/i, /\bcipher\s+\/w/i
]
export const assessCommand = (cmd: string): 'destructive' | 'ok' => (DESTRUCTIVE.some(re => re.test(cmd)) ? 'destructive' : 'ok')
// Comandos cujo uso tipico e destrutivo: um curinga sobre eles ("rm *") cobre o pior caso.
const DESTRUCTIVE_HEADS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'format', 'mkfs', 'dd', 'shutdown', 'reboot', 'sudo', 'taskkill', 'iex', 'invoke-expression', 'cipher'])
const INTERPRETERS = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'node', 'python', 'python3', 'py', 'npx', 'sudo', 'eval', 'env', 'xargs', 'wsl', 'start'])

export type Risk = { risk: 'low' | 'broad' | 'destructive'; reason: string }
export function assessRule(kind: 'bash' | 'tool', pattern: string): Risk {
  const p = collapse(pattern)
  if (kind === 'tool') {
    const base = p.endsWith('*') ? p.slice(0, -1) : null // curinga: cobre tudo que comecar assim
    return base !== null && (base === 'mcp__' || base.length < 5) ? { risk: 'broad', reason: 'libera muitas ferramentas de uma vez' } : { risk: 'low', reason: '' }
  }
  const wildcard = p === '*' || p.endsWith(' *')
  const prefix = p === '*' ? '' : wildcard ? p.slice(0, -2) : p
  const head = prefix.split(' ')[0].toLowerCase()
  if (assessCommand(prefix) === 'destructive' || (wildcard && DESTRUCTIVE_HEADS.has(head)))
    return { risk: 'destructive', reason: wildcard ? 'o prefixo cobre comandos destrutivos (apagar, sobrescrever historico, publicar, sudo, executar codigo baixado...)' : 'o comando e destrutivo' }
  if (!wildcard) return { risk: 'low', reason: '' }
  const toks = prefix.split(' ').filter(Boolean)
  if (toks.length === 0) return { risk: 'broad', reason: 'libera QUALQUER comando simples' }
  if (INTERPRETERS.has(toks[0].toLowerCase())) return { risk: 'broad', reason: `"${toks[0]}" executa qualquer coisa que vier depois` }
  if (toks.length === 1) return { risk: 'broad', reason: `libera todos os subcomandos de "${toks[0]}" (inclusive os que apagam ou sobrescrevem)` }
  return { risk: 'low', reason: '' }
}

// ---- Regras
export type Rule = { id: number; provider: string; kind: 'bash' | 'tool'; pattern: string; decision: 'allow' | 'deny'; risk: string; acknowledged: boolean; project: string; created_at: string }
const loadRule = (r: any): Rule => ({ ...r, acknowledged: !!r.acknowledged })
export const listRules = (db: DatabaseSync, provider?: string): Rule[] => all(db, 'SELECT * FROM permission_rules WHERE (? IS NULL OR provider=?) ORDER BY provider, id', provider ?? null, provider ?? null).map(loadRule)

export function addRule(db: DatabaseSync, r: { provider: string; kind: string; pattern: string; decision?: string; project?: string; acknowledged?: boolean }, providers: string[]): Rule {
  if (!providers.includes(r.provider)) throw new Error('Agente invalido.')
  if (r.kind !== 'bash' && r.kind !== 'tool') throw new Error('Tipo de regra invalido.')
  const decision = r.decision ?? 'allow'
  if (decision !== 'allow' && decision !== 'deny') throw new Error('Decisao invalida.')
  const pattern = collapse(String(r.pattern ?? ''))
  if (!pattern || pattern.length > 300 || /[\0\r\n]/.test(String(r.pattern))) throw new Error('Padrao invalido (ate 300 caracteres, uma linha).')
  const a = assessRule(r.kind, pattern)
  if (decision === 'allow') {
    // Destrutivo por prefixo/curinga: nunca. Destrutivo exato, amplo ou de risco: so com ciencia explicita do usuario.
    if (a.risk === 'destructive' && r.kind === 'bash' && (pattern === '*' || pattern.endsWith(' *'))) throw new Error(`Regra ampla recusada: ${a.reason}. Permita o comando exato, se for mesmo o que quer.`)
    if (a.risk !== 'low' && !r.acknowledged) throw new Error(`Esta regra e ${a.risk === 'destructive' ? 'DESTRUTIVA' : 'ampla'}: ${a.reason}. Confirme que entende o risco para salvar.`)
  }
  const project = r.project ?? ''
  const dup = get(db, 'SELECT id FROM permission_rules WHERE provider=? AND kind=? AND pattern=? AND project=?', r.provider, r.kind, pattern, project)
  if (dup) db.prepare('UPDATE permission_rules SET decision=?, risk=?, acknowledged=? WHERE id=?').run(decision, a.risk, r.acknowledged ? 1 : 0, dup.id)
  const id = dup?.id ?? Number(db.prepare('INSERT INTO permission_rules (provider, kind, pattern, decision, risk, acknowledged, project) VALUES (?,?,?,?,?,?,?)').run(r.provider, r.kind, pattern, decision, a.risk, r.acknowledged ? 1 : 0, project).lastInsertRowid)
  return loadRule(get(db, 'SELECT * FROM permission_rules WHERE id=?', id))
}
export const removeRule = (db: DatabaseSync, id: number) => Number(db.prepare('DELETE FROM permission_rules WHERE id=?').run(id).changes) > 0

export type Verdict = { verdict: 'allow' | 'deny' | 'ask'; rule?: Rule }
// Negar vence permitir. Comando destrutivo so e liberado por regra EXATA (um curinga nunca o cobre, mesmo reconhecido).
export function evaluate(db: DatabaseSync, o: { provider: string; kind: 'bash' | 'tool'; subject: string; project?: string }): Verdict {
  const rules = listRules(db, o.provider).filter(r => r.kind === o.kind && (r.project === '' || r.project === (o.project ?? '')) && matches(o.kind, r.pattern, o.subject))
  const deny = rules.find(r => r.decision === 'deny')
  if (deny) return { verdict: 'deny', rule: deny }
  const destructive = o.kind === 'bash' && assessCommand(o.subject) === 'destructive'
  const allow = rules.find(r => r.decision === 'allow' && (!destructive || !(r.pattern === '*' || r.pattern.endsWith(' *'))))
  return allow ? { verdict: 'allow', rule: allow } : { verdict: 'ask' }
}

// Sugestoes de "sempre permitir" para um pedido: o comando exato e, quando seguro, um prefixo de dois termos ("npm run *").
export type Suggestion = { pattern: string; label: string } & Risk
export function suggestions(s: Subject): Suggestion[] {
  const mk = (pattern: string, label: string): Suggestion => ({ pattern, label, ...assessRule(s.kind, pattern) })
  if (s.kind === 'tool') {
    const parts = s.subject.split('__')
    return [mk(s.subject, 'Somente esta ferramenta'), ...(parts[0] === 'mcp' && parts.length >= 3 ? [mk(`mcp__${parts[1]}__*`, 'Todas as ferramentas deste servidor MCP')] : [])]
  }
  const out = [mk(collapse(s.subject), 'Somente este comando')]
  const toks = collapse(s.subject).split(' ')
  if (isSimple(s.subject) && toks.length >= 3 && !toks[1].startsWith('-')) out.push(mk(`${toks[0]} ${toks[1]} *`, `Qualquer "${toks[0]} ${toks[1]} …"`))
  return out
}

// ---- Pedidos
export type PermissionState = 'pending' | 'allowed_once' | 'allowed_always' | 'allowed_rule' | 'denied' | 'denied_rule' | 'expired'
export type PermissionRequest = {
  id: number; task_id: number | null; run_id: number | null; delegation_id: number | null; provider: string; tool: string; kind: 'bash' | 'tool'
  command: string | null; summary: string; cwd: string | null; state: PermissionState; rule_id: number | null; risk: string | null; created_at: string; decided_at: string | null
  suggestions?: Suggestion[]
}
const loadReq = (r: any, withSug = false): PermissionRequest => ({
  ...r, ...(withSug && r.state === 'pending' ? { suggestions: suggestions(r.kind === 'bash' ? { kind: 'bash', subject: r.command, command: r.command } : { kind: 'tool', subject: r.tool }) } : {})
})

export function summarize(tool: string, input: any): string {
  let s: string
  if (SHELL_TOOLS.has(tool) && typeof input?.command === 'string') s = input.command + (typeof input.description === 'string' ? `\n(${input.description})` : '')
  else { try { s = JSON.stringify(input) } catch { s = '' } }
  return redact(s).slice(0, 2000)
}
// Como sanitize() (segredos), mas MANTEM URLs e caminhos: o usuario precisa ver o que esta autorizando. So o resumo e mascarado; o comando
// original continua no pedido para o casamento com as regras.
const redact = (s: string) =>
  s.replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer <redacted>').replace(/\b(?:sk|pk|AIza|ghp|gho|xox[bap])[-_A-Za-z0-9]{8,}/g, '<redacted>')
    .replace(/((?:token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1<redacted>')

export type Decision = 'allow_once' | 'allow_always' | 'deny'
export type PromptCtx = { provider: string; taskId?: number; runId?: number; delegationId?: number; cwd?: string }
export type Answer = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }

export class PermissionBroker {
  private waiting = new Map<number, (s: PermissionState) => void>()
  private db: DatabaseSync
  private o: { settings: () => PermissionSettings; providers: string[]; emit: (ev: object) => void }
  constructor(db: DatabaseSync, o: { settings: () => PermissionSettings; providers: string[]; emit: (ev: object) => void }) { this.db = db; this.o = o }

  // Chamado pela CLI (Claude) via MCP a cada acao que exigiria permissao. Regra decide sem incomodar; senao pergunta ao usuario e espera.
  async handle(ctx: PromptCtx, args: any, signal: AbortSignal): Promise<Answer> {
    const tool = typeof args?.tool_name === 'string' ? args.tool_name.slice(0, 200) : ''
    if (!tool) return { behavior: 'deny', message: 'Pedido de permissao invalido.' }
    const input = args.input ?? {}
    const s = subjectOf(tool, input)
    const risk = s.kind === 'bash' ? assessCommand(s.subject) : null
    const ins = (state: string, ruleId: number | null) => Number(this.db.prepare(
      `INSERT INTO permission_requests (task_id, run_id, delegation_id, provider, tool, kind, command, summary, cwd, state, rule_id, risk, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,${state === 'pending' ? 'NULL' : NOW})`)
      .run(ctx.taskId ?? null, ctx.runId ?? null, ctx.delegationId ?? null, ctx.provider, tool, s.kind, s.command ?? null, summarize(tool, input), ctx.cwd ?? null, state, ruleId, risk).lastInsertRowid)
    const v = evaluate(this.db, { provider: ctx.provider, kind: s.kind, subject: s.subject, project: ctx.cwd })
    if (v.verdict === 'allow') { ins('allowed_rule', v.rule!.id); return { behavior: 'allow', updatedInput: input } }
    if (v.verdict === 'deny') { ins('denied_rule', v.rule!.id); return { behavior: 'deny', message: `Negado pela regra "${v.rule!.pattern}" configurada no dashboard.` } }
    if (!this.o.settings().prompt) { ins('denied', null); return { behavior: 'deny', message: 'O dashboard nao esta perguntando permissoes (Configuracoes > Permissoes).' } }
    const id = ins('pending', null)
    this.o.emit({ permissionRequest: id, taskId: ctx.taskId })
    const state = await new Promise<PermissionState>(resolve => {
      const done = (st: PermissionState) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); this.waiting.delete(id); resolve(st) }
      const onAbort = () => done('expired')
      const timer = setTimeout(() => done('expired'), this.o.settings().timeoutMin * 60_000)
      this.waiting.set(id, done)
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort)
    })
    if (state === 'expired') {
      this.db.prepare(`UPDATE permission_requests SET state='expired', decided_at=${NOW} WHERE id=? AND state='pending'`).run(id)
      this.o.emit({ permissionResolved: id, taskId: ctx.taskId, state: 'expired' })
      return { behavior: 'deny', message: 'Sem resposta do usuario no tempo limite: negado.' }
    }
    return state === 'denied' ? { behavior: 'deny', message: 'O usuario negou esta acao.' } : { behavior: 'allow', updatedInput: input }
  }

  // Resposta do usuario (IPC). "Sempre permitir" cria a regra; o padrao escolhido PRECISA casar com este pedido e passa pelas protecoes de risco.
  resolve(id: number, decision: Decision, opt: { pattern?: string; project?: boolean; acknowledged?: boolean } = {}): { state: PermissionState; rule?: Rule } {
    const req = get(this.db, 'SELECT * FROM permission_requests WHERE id=?', id)
    if (!req) throw new Error('Pedido inexistente.')
    if (req.state !== 'pending') throw new Error(`Este pedido ja foi resolvido (${req.state}).`)
    let rule: Rule | undefined
    if (decision === 'allow_always') {
      const subject = req.kind === 'bash' ? req.command : req.tool
      const pattern = collapse(opt.pattern ?? subject)
      if (!matches(req.kind, pattern, subject)) throw new Error('O padrao escolhido nao cobre este pedido.')
      rule = addRule(this.db, { provider: req.provider, kind: req.kind, pattern, decision: 'allow', project: opt.project ? req.cwd ?? '' : '', acknowledged: opt.acknowledged }, this.o.providers)
    } else if (decision !== 'allow_once' && decision !== 'deny') throw new Error('Decisao invalida.')
    const state: PermissionState = decision === 'deny' ? 'denied' : decision === 'allow_once' ? 'allowed_once' : 'allowed_always'
    const done = this.db.prepare(`UPDATE permission_requests SET state=?, rule_id=?, decided_at=${NOW} WHERE id=? AND state='pending'`).run(state, rule?.id ?? null, id)
    if (!done.changes) throw new Error('Este pedido ja foi resolvido.')
    this.waiting.get(id)?.(state) // acorda a CLI que espera
    this.o.emit({ permissionResolved: id, taskId: req.task_id, state })
    return { state, rule }
  }

  list(o: { taskId?: number; recent?: number } = {}): PermissionRequest[] {
    const pend = all(this.db, "SELECT * FROM permission_requests WHERE state='pending' AND (? IS NULL OR task_id=?) ORDER BY id", o.taskId ?? null, o.taskId ?? null).map(r => loadReq(r, true))
    const rec = all(this.db, "SELECT * FROM permission_requests WHERE state<>'pending' AND (? IS NULL OR task_id=?) ORDER BY id DESC LIMIT ?", o.taskId ?? null, o.taskId ?? null, o.recent ?? 20).map(r => loadReq(r))
    return [...pend, ...rec]
  }
  // Execucao terminou/cancelou ou o app reiniciou: pedidos pendentes perdem o sentido (aprovar depois nao faz nada).
  expire(o: { runId?: number; delegationId?: number } = {}) {
    const cond = ["state='pending'"]; const a: any[] = []
    if (o.runId) { cond.push('run_id=?'); a.push(o.runId) }
    if (o.delegationId) { cond.push('delegation_id=?'); a.push(o.delegationId) }
    const ids = all(this.db, `SELECT id FROM permission_requests WHERE ${cond.join(' AND ')}`, ...a).map(r => r.id as number)
    this.db.prepare(`UPDATE permission_requests SET state='expired', decided_at=${NOW} WHERE ${cond.join(' AND ')}`).run(...a)
    for (const id of ids) this.waiting.get(id)?.('expired')
    return ids.length
  }
}

// ---- Ferramenta MCP que o Claude usa como --permission-prompt-tool
export const PERMISSION_TOOL_NAME = 'permission_prompt'
export const PERMISSION_TOOL: ToolDef = {
  name: PERMISSION_TOOL_NAME,
  description: 'Uso interno da CLI para pedir permissao ao usuario. Nao chame.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] }
}
export const answerText = (a: Answer) => JSON.stringify(a) // formato esperado pelo Claude Code: {"behavior":"allow","updatedInput":...} | {"behavior":"deny","message":...}

// ---- Politica nativa onde a CLI nao pergunta (Codex exec e OpenCode run): "sempre permitir" vira sandbox/--auto + regras como permissoes.
// Nunca alarga o modo leitura: quem chama so aplica isto a execucoes de edicao/chat.
export function nativePolicy(provider: string, s: PermissionSettings, rules: Rule[]): { opts: Partial<ChatOpts>; permission?: object } {
  if (provider === 'codex') return { opts: { sandbox: s.codexSandbox, network: s.codexSandbox === 'workspace-write' && s.codexNetwork } }
  if (provider === 'opencode') {
    const bash: Record<string, string> = {}
    const global = rules.filter(r => r.kind === 'bash' && r.project === '') // regras por projeto nao viram configuracao global da CLI
    for (const r of global.filter(r => r.decision === 'allow')) bash[r.pattern] = 'allow'
    for (const r of global.filter(r => r.decision === 'deny')) bash[r.pattern] = 'deny' // negar vence: aplicado por ultimo
    return { opts: { extra: s.opencodeAuto ? ['--auto'] : [] }, ...(Object.keys(bash).length ? { permission: { bash } } : {}) }
  }
  if (provider === 'claude' && s.claudeAuto) return { opts: { permissionMode: 'auto' } }
  return { opts: {} }
}

// Delegacao entre plataformas: um agente (pai) chama a ferramenta MCP local e o dashboard executa um agente FILHO
// em outro provedor, dentro da area de trabalho da tarefa do pai. Um nivel apenas, um escritor por area, permissoes
// nunca ampliadas, limites e timeout configuraveis, tudo rastreavel. Contexto ja existente so segue ao filho com pacote
// aprovado pelo usuario (consent.ts); o resultado novo do filho volta ao pai como parte da ordem. Sem dependencia de 'electron'.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { AGENTS, SAFE_ARG, type ChatOpts } from './adapters.ts'
import { describeAliases, resolveAlias, type AgentAlias } from './agents.ts'
import { saveArtifact } from './artifacts.ts'
import {
  ApprovalWaiters, bindGrantSession, bindSession, createPackage, currentPackage, finishDelivery, getPackage, invalidatePending, openGrant, pendingItems, PackageLimitError, recordDelivery, renderPackage, verifyForDelivery,
  type Grant, type PackageItem, type PackageRow, type Recipient
} from './consent.ts'
import { buildEnvelope, excerpt, extractConclusion, type Conclusion } from './envelope.ts'
import { inScope, pathKey, safeJoin, sameKey } from './guard.ts'
import type { ContextLimits } from './limits.ts'
import type { ToolDef, ToolResult } from './mcp.ts'
import { addMemory, buildCheckpoint } from './memory.ts'
import { buildChildInput, runtimeBrief } from './prompt.ts'
import type { ChatResult } from './runner.ts'
import { readableItems } from './taskContext.ts'
import { profileOf } from './tasks.ts'
import { recordUsage } from './usage.ts'
import { readFileRange } from './workspaceTools.ts'

export { inScope }

// ---- Configuracoes (Configuracoes > Delegacao)
export type DelegationSettings = {
  enabled: boolean; maxPerTask: number; timeoutMin: number; allowEdit: boolean; allowedProviders: string[]
  // true = recusa delegacoes de edicao, porque nenhum mecanismo verificavel suspende o pai enquanto o filho edita (ver README)
  requireParentSuspension: boolean
  readAgent: string // agente nomeado padrao para mode "read" sem agent/provider ('' = o pai escolhe). Regra fixa do usuario: o agente nao estima custo
}
export const DEFAULT_SETTINGS: DelegationSettings = { enabled: true, maxPerTask: 10, timeoutMin: 15, allowEdit: true, allowedProviders: Object.keys(AGENTS), requireParentSuspension: false, readAgent: '' }
const clamp = (v: unknown, min: number, max: number, dflt: number) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : dflt)
export function normalizeSettings(raw: any): DelegationSettings {
  const d = DEFAULT_SETTINGS
  return {
    enabled: raw?.enabled === undefined ? d.enabled : raw.enabled === true,
    maxPerTask: clamp(raw?.maxPerTask, 1, 50, d.maxPerTask),
    timeoutMin: clamp(raw?.timeoutMin, 1, 120, d.timeoutMin),
    allowEdit: raw?.allowEdit === undefined ? d.allowEdit : raw.allowEdit === true,
    allowedProviders: Array.isArray(raw?.allowedProviders) ? raw.allowedProviders.filter((p: unknown) => typeof p === 'string' && Object.hasOwn(AGENTS, p)) : d.allowedProviders,
    requireParentSuspension: raw?.requireParentSuspension === undefined ? d.requireParentSuspension : raw.requireParentSuspension === true,
    readAgent: typeof raw?.readAgent === 'string' ? raw.readAgent.trim().slice(0, 40) : d.readAgent
  }
}

// ---- Ferramenta MCP
export const TOOL_NAME = 'delegate_to_agent'
export const MAX_FILES = 5 // trechos indicados pelo pai (files)
// A descricao carrega o catalogo de agentes nomeados do usuario (recalculado a cada tools/list: salvar em Configuracoes vale na proxima execucao).
export const delegateTool = (aliases: AgentAlias[] = [], readAgent = ''): ToolDef => {
  const reader = readAgent ? resolveAlias(aliases, readAgent) : undefined
  return {
  name: TOOL_NAME,
  description:
    'Delega UMA unidade coerente de trabalho (escopo, criterio de entrega, validacao) a OUTRO provedor; devolve envelope curto (status, conclusao, arquivos, alertas, referencia ao resultado completo). ' +
    (aliases.length
      ? `Agentes nomeados pelo usuario: ${describeAliases(aliases)}. Quando o usuario citar um desses nomes (com ou sem acento/maiuscula), passe-o em "agent" e NAO pergunte provedor nem id de modelo. `
      : '') +
    // Regra fixa por tipo de trabalho (sem estimar custo): o que encarece e o que entra no SEU contexto, relido em toda chamada seguinte.
    'Delegue quando a saida e grande e o resultado curto: testes/build/e2e trazendo so as falhas, buscas amplas, resumir varios arquivos, edicoes mecanicas num escopo definido. ' +
    'Faca voce mesmo: edicao pontual, leitura de trecho ja localizado, a decisao. ' +
    (reader ? `Sem agent e sem provider, mode "read" vai para ${reader.name} (padrao do usuario para leitura e testes). ` : '') +
    'Nao delegue o que o programa faz sozinho (listar, filtrar logs, diff, contagens) nem um filho por arquivo. Um nivel: o filho nao delega. ' +
    'mode "read" = somente leitura (aplicado pelo executor); "edit" edita a pasta da tarefa (voce NAO e suspenso: nao edite o escopo enquanto espera). ' +
    'A ordem (objective) segue sem aprovacao; QUALQUER contexto existente (context, memoryIds) so vai depois que o usuario aprovar o pacote exato. ' +
    'Corrigir o mesmo filho: continuationOf. Sem segredos. Chamada sincrona.',
  inputSchema: {
    type: 'object',
    properties: {
      objective: { type: 'string', description: 'Ordem direta: o que fazer e o que devolver.' },
      ...(aliases.length ? { agent: { type: 'string', enum: aliases.map(a => a.name), description: 'Agente nomeado (define provedor, modelo e esforco).' } } : {}),
      provider: { type: 'string', enum: Object.keys(AGENTS), description: 'Dispensavel com agent.' },
      model: { type: 'string', description: 'Omitido = padrao do provedor.' },
      effort: { type: 'string' },
      mode: { type: 'string', enum: ['read', 'edit'], description: 'Padrao: read.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Escopo (caminhos relativos); alteracao fora dele e sinalizada.' },
      files: { type: 'array', maxItems: MAX_FILES, items: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'] }, description: 'Trechos que voce ja localizou: o dashboard os le do disco e entrega com a ordem (o filho nao gasta passos procurando). Leitura nova, sem aprovacao.' },
      context: { type: 'string', description: 'Contexto existente a compartilhar (exige aprovacao).' },
      memoryIds: { type: 'array', items: { type: 'integer' }, description: 'IDs de read_task_context a compartilhar (exige aprovacao).' },
      approvedPackageId: { type: 'integer', description: 'Pacote ja aprovado para ESTE destinatario.' },
      continuationOf: { type: 'integer', description: 'Delegacao a continuar (mesma unidade, provedor, modelo, esforco, modo e escopo).' }
    },
    required: aliases.length ? ['objective'] : ['objective', 'provider']
  }
  }
}
export const DELEGATE_TOOL = delegateTool()

export type FileRef = { path: string; startLine?: number; endLine?: number }
export type DelegateArgs = {
  objective: string; provider: string; model?: string; effort?: string; mode: 'read' | 'edit'; paths: string[]; files: FileRef[]; context: string
  memoryIds: number[]; approvedPackageId?: number; continuationOf?: number; agent?: string // agent: nome do agente nomeado usado
}
const bad = (m: string): never => { throw new Error(m) }
// `agent` resolve provedor/modelo/esforco pelo catalogo do usuario. Se vier junto com provider/model/effort DIFERENTES, recusa: nada e substituido em silencio.
// Sem agent e sem provider, leitura vai para o agente padrao de leitura do usuario (Configuracoes > Delegacao), quando houver.
function resolveTarget(raw: any, aliases: AgentAlias[], readAgent = ''): { provider: unknown; model: unknown; effort: unknown; agent?: string } {
  const empty = (v: unknown) => v == null || v === ''
  if (empty(raw.agent) && empty(raw.provider) && (raw.mode ?? 'read') === 'read' && readAgent) raw = { ...raw, agent: readAgent }
  if (empty(raw.agent)) return { provider: raw.provider, model: raw.model, effort: raw.effort }
  const al = typeof raw.agent === 'string' ? resolveAlias(aliases, raw.agent) : undefined
  if (!al) return bad(`agent "${String(raw.agent).slice(0, 40)}" nao existe. Agentes cadastrados: ${aliases.length ? aliases.map(a => a.name).join(', ') : 'nenhum (o usuario os cria em Configuracoes)'}.`)
  const differs = (given: unknown, want?: string) => given != null && given !== '' && given !== want
  if (differs(raw.provider, al.provider) || differs(raw.model, al.model) || differs(raw.effort, al.effort))
    bad(`"${al.name}" e ${al.provider} / ${al.model}${al.effort ? ` (esforco ${al.effort})` : ''}: nao informe provider/model/effort diferentes com agent (nada e substituido em silencio).`)
  return { provider: al.provider, model: al.model, effort: al.effort, agent: al.name }
}
export function parseArgs(raw: any, s: DelegationSettings, aliases: AgentAlias[] = []): DelegateArgs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('Argumentos invalidos: envie um objeto.')
  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : ''
  if (!objective || objective.length > 4000) bad('objective e obrigatorio (ate 4000 caracteres).')
  const target = resolveTarget(raw, aliases, s.readAgent)
  raw = { ...raw, provider: target.provider, model: target.model, effort: target.effort }
  if (typeof raw.provider !== 'string' || !Object.hasOwn(AGENTS, raw.provider)) bad(`provider invalido. Opcoes: ${Object.keys(AGENTS).join(', ')}.`)
  if (!s.allowedProviders.includes(raw.provider)) bad(`O compartilhamento com "${raw.provider}" nao esta permitido nas configuracoes de delegacao.`)
  const arg = (v: unknown, name: string) => (v == null || v === '' ? undefined : typeof v === 'string' && SAFE_ARG.test(v) ? v : bad(`${name} invalido.`))
  const mode = raw.mode == null ? 'read' : raw.mode
  if (mode !== 'read' && mode !== 'edit') bad('mode deve ser "read" ou "edit".')
  const paths = raw.paths == null ? [] : raw.paths
  if (!Array.isArray(paths) || paths.length > 20 || paths.some((p: unknown) => typeof p !== 'string' || !p || p.length > 300 || /[\0\r\n]/.test(p))) bad('paths deve ser uma lista de ate 20 caminhos relativos.')
  const files = raw.files == null ? [] : raw.files
  const line = (v: unknown) => v == null || (Number.isSafeInteger(v) && (v as number) > 0)
  if (!Array.isArray(files) || files.length > MAX_FILES || files.some((f: any) => !f || typeof f.path !== 'string' || !f.path || f.path.length > 300 || /[\0\r\n]/.test(f.path) || !line(f.startLine) || !line(f.endLine)))
    bad(`files deve ser uma lista de ate ${MAX_FILES} trechos { path, startLine?, endLine? } com linhas inteiras positivas.`)
  const context = raw.context == null ? '' : raw.context
  if (typeof context !== 'string' || context.length > 8000) bad('context deve ser texto de ate 8000 caracteres.')
  const memoryIds = raw.memoryIds == null ? [] : raw.memoryIds
  if (!Array.isArray(memoryIds) || memoryIds.length > 20 || memoryIds.some((n: unknown) => !Number.isSafeInteger(n) || (n as number) <= 0)) bad('memoryIds deve ser uma lista de ate 20 IDs inteiros.')
  const id = (v: unknown, name: string) => (v == null ? undefined : Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : bad(`${name} invalido.`))
  return { objective, provider: raw.provider, model: arg(raw.model, 'model'), effort: arg(raw.effort, 'effort'), mode, paths, files: files.map((f: any) => ({ path: f.path, ...(f.startLine ? { startLine: f.startLine } : {}), ...(f.endLine ? { endLine: f.endLine } : {}) })), context, memoryIds, approvedPackageId: id(raw.approvedPackageId, 'approvedPackageId'), continuationOf: id(raw.continuationOf, 'continuationOf'), ...(target.agent ? { agent: target.agent } : {}) }
}

// Trechos indicados pelo pai: leitura NOVA do disco, feita pelo dashboard com as mesmas regras do read_file_range do filho (caminho real,
// escopo, limite de linhas) e, com MCP, sob a identidade do filho (recibos validos: ele amplia com readToken sem receber de novo).
// Equivale ao filho ler sozinho, por isso nao e pacote de contexto. Orcamento total fixo; o que nao cabe e listado, nunca cortado em silencio.
export const FILES_CHARS = 12_000
export function fileExcerpts(files: FileRef[], ws: { cwd: string; scope: string[]; session?: string }): string {
  if (!files.length) return ''
  const ctx = { cwd: ws.cwd, allow: ws.scope.length ? (f: string) => inScope(f, ws.scope) : undefined, session: ws.session }
  const out: string[] = []
  let left = FILES_CHARS
  for (const f of files) {
    if (left < 400) { out.push(`${f.path}: nao anexado (limite de ${FILES_CHARS} caracteres dos trechos); leia se precisar.`); continue }
    let text: string
    try { text = readFileRange(ctx, f, { maxChars: left - 300 }) } catch (e: any) { text = `${f.path}: nao anexado (${String(e?.message ?? e).slice(0, 200)})` }
    out.push(text); left -= text.length
  }
  return out.join('\n\n')
}

// Caminhos do escopo: relativos e DENTRO da area de trabalho (valida o caminho real; nao aceita absolutos, .. nem links para fora).
export function scopePaths(workspace: string, paths: string[]): string[] {
  return paths.map(p => {
    if (p === '.') return '.'
    if (path.isAbsolute(p) || /^[a-z]:/i.test(p) || p.split(/[\\/]/).includes('..')) bad(`Caminho fora da area de trabalho: "${p}".`)
    const real = safeJoin(workspace, p) // falha se sair da area (inclusive por link/junction)
    return path.relative(fs.realpathSync(workspace), real).split(path.sep).join('/') || '.'
  })
}

// ---- Alteracoes de arquivos: comparacao de instantaneos (independe de Git)
const SKIP = new Set(['node_modules', '.git', '.worktrees', 'out', 'dist', 'build', '.godot', '.import', 'tmp', 'temp'])
export type Snap = Map<string, string>
export function snapshot(root: string, limit = 20000): Snap | null {
  const snap: Snap = new Map()
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return true }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !walk(abs)) return false }
      else if (e.isFile()) {
        if (snap.size >= limit) return false
        try { const st = fs.statSync(abs); snap.set(path.relative(root, abs).split(path.sep).join('/'), `${st.size}:${Math.round(st.mtimeMs)}`) } catch {}
      }
    }
    return true
  }
  return walk(root) ? snap : null // null = pasta grande demais para acompanhar
}
export function diffSnap(a: Snap, b: Snap): string[] {
  const out = new Set<string>()
  for (const [k, v] of b) if (a.get(k) !== v) out.add(k)
  for (const k of a.keys()) if (!b.has(k)) out.add(k)
  return [...out].sort()
}

// ---- Um escritor por area de trabalho
export class WorkspaceGuard {
  private edits = new Map<string, { taskId: number; delegationId: number }>()
  private key = pathKey
  // Mensagem de bloqueio se OUTRA tarefa tem uma delegacao de edicao ativa nesta area.
  blockedFor(ws: string, taskId: number): string | null {
    const h = this.edits.get(this.key(ws))
    return h && h.taskId !== taskId ? `A pasta de trabalho esta reservada por uma delegacao de edicao da tarefa #${h.taskId}. Aguarde ela terminar.` : null
  }
  acquireEdit(ws: string, taskId: number, delegationId: number, othersActiveHere: boolean): string | null {
    const h = this.edits.get(this.key(ws))
    if (h) return `Ja existe uma delegacao de edicao ativa nesta pasta (tarefa #${h.taskId}). Um escritor por area de trabalho.`
    if (othersActiveHere) return 'Outra tarefa esta executando nesta mesma pasta: espere ela terminar antes de delegar uma edicao.'
    this.edits.set(this.key(ws), { taskId, delegationId })
    return null
  }
  release(ws: string, delegationId: number) {
    if (this.edits.get(this.key(ws))?.delegationId === delegationId) this.edits.delete(this.key(ws))
  }
}

// ---- Execucao filha
export type Child = { cancel: (sync?: boolean) => void; result: Promise<ChatResult> }
export type ParentCtx = {
  taskId: number; runId: number; provider: string; accountId?: number; cwd: string
  lineage: string // 'chat:<tarefa>:<provedor>:<perfil>': identifica a conversa do pai
  auth: Grant // identidade efetiva desta execucao do pai (criada pelo backend): dona do que ele registrou e enxerga, e leitora dos artefatos dos filhos
  depth: number // 0 = execucao do usuario; filhos nunca recebem a ferramenta, esta checagem e uma segunda barreira
  fails: Map<string, number> // falhas seguidas por provedor nesta execucao
  children: Set<{ cancel: (sync?: boolean) => void }> // cancelados junto com o pai
  godotOrganizerId?: string // capacidade herdada da invocação, revalidada pelo MCP a cada consulta
}
// Ferramentas de contexto/area de trabalho que o filho recebe (nunca delegate_to_agent). null = CLI sem transporte compativel.
// native: ferramentas nativas do filho quando ele tem o MCP (ver taskContext.childToolset); keepSession: a execucao terminou na MESMA sessao nativa,
// entao recibos de leitura e skills entregues continuam validos para uma continuacao dela.
// tools: nomes das ferramentas MCP anunciadas (o resumo de regras so cita o que existe); ausente = conjunto completo do filho.
export type ChildWire = { extra: string[]; env: Record<string, string>; native?: string[]; tools?: string[]; cleanup: (keepSession?: boolean) => void }
export type Deps = {
  db: DatabaseSync
  guard: WorkspaceGuard
  settings: () => DelegationSettings
  limits: () => ContextLimits
  aliases?: () => AgentAlias[] // agentes nomeados pelo usuario (Configuracoes)
  nativePolicy?: (provider: string) => { opts: Partial<ChatOpts>; permission?: object } // "sempre permitir" nativo por CLI (permissions.ts)
  waiters: ApprovalWaiters
  catalogCheck: (provider: string, model?: string, effort?: string) => Promise<string | null>
  runChild: (p: { provider: string; opts: ChatOpts; cwd: string; env: NodeJS.ProcessEnv; input: string; session?: string }) => Child
  childTools?: (p: { taskId: number; lineage: string; auth: Grant; delegationId: number; provider: string; mode: 'read' | 'edit'; cwd: string; scope: string[]; godotOrganizerId?: string }) => Promise<ChildWire | null>
  envFor: (provider: string, accountId?: number) => NodeJS.ProcessEnv
  otherTasksActiveIn: (workspace: string, taskId: number) => boolean
  note: (taskId: number, text: string) => void // mensagem de sistema no chat do pai (+ atualizacao da tela)
  onContextRequest: (pkg: PackageRow) => void // avisa a interface que ha um pedido de aprovacao pendente
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const PT: Record<string, string> = { completed: 'concluida', failed: 'falhou', cancelled: 'cancelada' }

// Somente leitura no opencode nao tem flag: a permissao vai por configuracao inline (verificado: `opencode agent list`).
// Claude em leitura (sem Bash): as instrucoes de commit/PR e o git status que a CLI poe no prompt de sistema so custam tokens a cada passo.
// CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS desliga os dois (verificado na 2.1.284; qualquer valor definido desliga). So o processo filho e afetado.
export function readOnlyEnv(provider: string): Record<string, string> {
  if (provider === 'opencode') return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'deny', bash: 'deny', write: 'deny' } }) }
  return provider === 'claude' ? { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' } : {}
}

// Por que uma delegacao anterior NAO pode ser continuada (lista vazia = compativel). Qualquer diferenca de provedor, modelo, esforco,
// modo, escopo, conta ou area invalida a sessao: seria outro destino de contexto.
export function continuationProblems(prev: any, a: DelegateArgs, scope: string[], cwd: string, accountId: number | null): string[] {
  const why: string[] = []
  if (['running', 'awaiting_context_approval'].includes(prev.status)) why.push('ela ainda esta em andamento')
  if (!prev.session_id) why.push('nao ha sessao registrada para retomar')
  if (prev.provider !== a.provider) why.push('provedor diferente')
  if ((prev.model ?? null) !== (a.model ?? null)) why.push('modelo diferente')
  if ((prev.effort ?? null) !== (a.effort ?? null)) why.push('esforco diferente')
  if (prev.mode !== a.mode) why.push('modo diferente')
  if (JSON.stringify([...JSON.parse(prev.paths ?? '[]')].sort()) !== JSON.stringify([...scope].sort())) why.push('escopo diferente')
  if ((prev.account_id ?? null) !== (accountId ?? null)) why.push('conta diferente')
  if (!sameKey(prev.workspace ?? '', cwd)) why.push('area de trabalho diferente')
  return why
}

export async function runDelegation(d: Deps, ctx: ParentCtx, raw: unknown, signal: AbortSignal): Promise<ToolResult> {
  const err = (text: string): ToolResult => ({ text: `Delegacao recusada: ${text}`, isError: true })
  const s = d.settings(), lim = d.limits()
  if (!s.enabled) return err('a delegacao esta desativada nas configuracoes.')
  if (ctx.depth !== 0) return err('recursao nao e permitida: um agente delegado nao pode delegar.')
  let a: DelegateArgs
  try { a = parseArgs(raw, s, d.aliases?.() ?? []) } catch (e: any) { return err(e.message) }
  if (a.mode === 'edit' && !s.allowEdit) return err('delegacoes de edicao estao desativadas nas configuracoes.')
  if (a.mode === 'edit' && s.requireParentSuspension) return err('delegacao de edicao exige suspender o pai, e nenhum mecanismo verificavel de suspensao/restricao do pai esta disponivel; use mode "read" ou desative "exigir suspensao do pai" em Configuracoes.')
  const used = (d.db.prepare('SELECT COUNT(*) n FROM delegations WHERE task_id=?').get(ctx.taskId) as any).n
  if (used >= s.maxPerTask) return err(`limite de ${s.maxPerTask} delegacoes por tarefa atingido (ajuste em Configuracoes).`)
  if ((ctx.fails.get(a.provider) ?? 0) >= 2) return err(`duas delegacoes seguidas para ${a.provider} falharam nesta execucao; nao vou repetir. Escolha outro provedor ou resolva a falha.`)
  let scope: string[]
  try { scope = scopePaths(ctx.cwd, a.paths) } catch (e: any) { return err(e.message) }
  const catErr = await d.catalogCheck(a.provider, a.model, a.effort)
  if (catErr) return err(`${catErr} Nenhuma substituicao de modelo foi feita.`)
  const accountId = ctx.provider === a.provider ? ctx.accountId ?? null : null

  // Continuacao: so da mesma unidade de trabalho e sessao compativel; nunca reaproveita um filho "porque esta disponivel".
  let sid: string | undefined, lineage = ''
  if (a.continuationOf) {
    const prev = d.db.prepare('SELECT * FROM delegations WHERE id=? AND task_id=?').get(a.continuationOf, ctx.taskId) as any
    const why = prev ? continuationProblems(prev, a, scope, ctx.cwd, accountId) : ['delegacao inexistente nesta tarefa']
    if (why.length) return err(`nao da para continuar a delegacao #${a.continuationOf}: ${why.join('; ')}. Chame sem continuationOf para iniciar uma sessao nova (o que a anterior sabia so segue em pacote aprovado pelo usuario).`)
    sid = prev.session_id; lineage = prev.lineage ?? `del:${prev.id}`
  }

  // Contexto candidato: qualquer coisa que JA EXISTA (texto do pai, memorias). A ordem direta (objective) nao entra aqui.
  const candidate: PackageItem[] = []
  if (a.context.trim()) candidate.push({ ref: 'ctx', kind: 'context', title: 'Contexto informado pelo agente pai', content: a.context.trim() })
  if (a.memoryIds.length) {
    const avail = readableItems(d.db, ctx.auth)
    for (const mid of a.memoryIds) {
      const r = avail.find(x => x.itemId === mid)
      if (!r) return err(`o item de memoria #${mid} nao esta disponivel para voce nesta tarefa.`)
      if (r.state === 'stale' || r.state === 'superseded') return err(`o item de memoria #${mid} esta ${r.state === 'stale' ? 'desatualizado' : 'substituido'}: revalide-o antes de compartilhar.`)
      candidate.push({ ref: `m:${mid}`, itemId: mid, revision: r.revision, kind: r.kind, title: r.title, content: r.content })
    }
  }

  const insert = d.db.prepare('INSERT INTO delegations (task_id, parent_run_id, provider, account_id, model, effort, mode, objective, paths, workspace, continuation_of) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(ctx.taskId, ctx.runId, a.provider, accountId, a.model ?? null, a.effort ?? null, a.mode, a.objective, JSON.stringify(scope), ctx.cwd, a.continuationOf ?? null)
  const id = Number(insert.lastInsertRowid)
  lineage ||= `del:${id}`
  d.db.prepare('UPDATE delegations SET lineage=? WHERE id=?').run(lineage, id)
  const fail = (status: 'failed' | 'cancelled', category: string, error: string) =>
    d.db.prepare('UPDATE delegations SET status=?, error=?, category=?, ended_at=CURRENT_TIMESTAMP WHERE id=?').run(status, error, category, id)
  const recipient: Recipient = { logicalId: lineage, provider: a.provider, profile: profileOf(a.provider, accountId), model: a.model ?? null, effort: a.effort ?? null, workspace: ctx.cwd, scope }

  // Pacotes a entregar: um ja aprovado (so o que a sessao ainda nao recebeu) e/ou o candidato novo, depois da decisao humana.
  const deliver: { pkg: PackageRow; items: PackageItem[]; uncertain: boolean }[] = []
  if (a.approvedPackageId) {
    const p = getPackage(d.db, a.approvedPackageId, ctx.taskId)
    const problem = !p ? 'pacote inexistente nesta tarefa.' : verifyForDelivery(d.db, p.id, recipient, sid ?? null)
    if (problem) { fail('failed', 'permission', problem); return err(problem) }
    const pend = pendingItems(d.db, p!, sid ?? '')
    if (pend.items.length) deliver.push({ pkg: p!, ...pend })
  }
  if (candidate.length) {
    let pkg: PackageRow
    try { pkg = createPackage(d.db, lim, { taskId: ctx.taskId, source: 'delegation', issuer: ctx.lineage, recipient, items: candidate, delegationId: id, parentRunId: ctx.runId }) }
    catch (e: any) { fail('failed', e instanceof PackageLimitError ? 'config' : 'unknown', e.message); return err(e.message) }
    d.db.prepare("UPDATE delegations SET status='awaiting_context_approval', package_id=? WHERE id=?").run(pkg.id, id)
    d.onContextRequest(pkg)
    // A espera humana NAO conta no timeout do filho (o relogio dele so comeca depois). Se o pai desistir ou o transporte MCP expirar, o pedido e invalidado.
    const w = await d.waiters.wait(pkg.id, signal, lim.approvalTimeoutMin * 60_000)
    if (w === 'approved') {
      const cur = currentPackage(d.db, pkg.id)! // aprovado em parte: segue o subconjunto que o usuario manteve
      const problem = verifyForDelivery(d.db, cur.id, recipient, sid ?? null)
      if (problem) { fail('failed', 'permission', problem); return err(problem) }
      deliver.push({ pkg: cur, items: cur.items, uncertain: false })
      d.db.prepare("UPDATE delegations SET status='running', package_id=? WHERE id=?").run(cur.id, id)
    } else if (w === 'rejected') {
      d.db.prepare("UPDATE delegations SET status='running' WHERE id=?").run(id)
      d.note(ctx.taskId, `↳ Delegacao #${id}: contexto recusado; o filho recebe so a ordem direta e investiga por conta propria.`)
    } else {
      const why = w === 'timeout' ? `sem resposta do usuario em ${lim.approvalTimeoutMin} min` : w === 'aborted' ? 'o agente pai cancelou ou a chamada MCP expirou' : 'cancelada pelo usuario'
      invalidatePending(d.db, { id: pkg.id, state: w === 'timeout' ? 'expired' : 'cancelled', reason: why })
      fail('cancelled', 'permission', `Delegacao nao iniciada: pedido de contexto nao aprovado (${why}).`)
      d.note(ctx.taskId, `↳ Delegacao #${id} nao iniciada: pedido de contexto nao aprovado (${why}).`)
      return err(`nao iniciada, o pedido de contexto nao foi aprovado (${why}). Chame novamente sem context/memoryIds para enviar so a ordem direta.`)
    }
  }

  if (a.mode === 'edit') {
    const lock = d.guard.acquireEdit(ctx.cwd, ctx.taskId, id, d.otherTasksActiveIn(ctx.cwd, ctx.taskId))
    if (lock) { fail('failed', 'permission', lock); return err(lock) }
  }
  const target = `${a.agent ? `${a.agent} = ` : ''}${a.provider}${a.model ? `/${a.model}` : ''}${a.effort ? ` (${a.effort})` : ''}`
  d.note(ctx.taskId, `↳ Delegacao #${id}${a.continuationOf ? ` (continuacao da #${a.continuationOf})` : ''} para ${target} em modo ${a.mode === 'read' ? 'somente leitura' : 'edicao'}${scope.length ? ` · escopo: ${scope.join(', ')}` : ''}${a.files.length ? ` · trechos anexados: ${a.files.map(f => f.path).join(', ')}` : ''}: “${clip(a.objective, 200)}”`)

  const before = snapshot(ctx.cwd)
  // Identidade efetiva do filho (criada aqui, nunca informada por ele): continuacao legitima = mesma sessao + mesmo destinatario = mesmo grant.
  const grant = openGrant(d.db, { taskId: ctx.taskId, recipient, sessionId: sid ?? null })
  const wire = await d.childTools?.({ taskId: ctx.taskId, lineage, auth: grant, delegationId: id, provider: a.provider, mode: a.mode, cwd: ctx.cwd, scope, godotOrganizerId: ctx.godotOrganizerId }).catch(() => null) ?? null
  // Politica nativa de "sempre permitir" (Codex sandbox/rede, OpenCode --auto e regras): so em edicao. O modo leitura nunca e alargado.
  const np = a.mode === 'edit' ? d.nativePolicy?.(a.provider) : undefined
  const extra = [...(wire?.extra ?? []), ...(np?.opts.extra ?? [])]
  const opts: ChatOpts = { model: a.model, effort: a.effort, mode: a.mode, ...(wire?.native ? { tools: wire.native } : {}), ...(np?.opts.sandbox ? { sandbox: np.opts.sandbox } : {}), ...(np?.opts.network ? { network: true } : {}), ...(np?.opts.permissionMode ? { permissionMode: np.opts.permissionMode } : {}), ...(extra.length ? { extra } : {}) }
  const ro = a.mode === 'read' ? readOnlyEnv(a.provider) : {}
  const env: Record<string, string | undefined> = { ...d.envFor(a.provider, accountId ?? undefined), ...ro, ...wire?.env }
  // OPENCODE_CONFIG_CONTENT e uma unica variavel: permissoes nativas, MCP e somente-leitura precisam ser MESCLADOS (o ultimo vence: leitura nega tudo).
  const cfgs = [np?.permission ? JSON.stringify({ permission: np.permission }) : '', wire?.env.OPENCODE_CONFIG_CONTENT ?? '', ro.OPENCODE_CONFIG_CONTENT ?? ''].filter(Boolean)
  if (cfgs.length > 1 || (cfgs.length === 1 && np?.permission)) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(cfgs.map(c => JSON.parse(c)).reduce((m, c) => ({ ...m, ...c, ...(m.permission || c.permission ? { permission: { ...m.permission, ...c.permission } } : {}) }), {}))
  const excerptsText = fileExcerpts(a.files, { cwd: ctx.cwd, scope, session: wire ? grant.authId : undefined })
  const packageText = deliver.length ? renderPackage(deliver.flatMap(x => x.items), { uncertain: deliver.some(x => x.uncertain) }) : ''
  const input = buildChildInput({
    mode: a.mode, scope, objective: a.objective, filesText: excerptsText, rangeTool: !!wire, packageText, delegationId: id, continuationOf: a.continuationOf,
    brief: runtimeBrief({ memoryTools: !!wire, workspaceTools: !!wire, nativeSearch: !!wire?.native?.includes('Grep'), testEvidence: !wire?.tools || wire.tools.includes('test_evidence'), ...(wire ? { skills: 'child' as const } : {}) }) // sem MCP compativel: so o resumo minimo
  })
  const deliveries = deliver.map(x => ({ x, id: recordDelivery(d.db, x.pkg, sid ?? '', x.items) }))

  const child = d.runChild({ provider: a.provider, opts, cwd: ctx.cwd, env, input, session: sid })
  ctx.children.add(child)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.cancel() }, s.timeoutMin * 60_000)
  const onAbort = () => child.cancel() // o pai desistiu da chamada
  signal.addEventListener('abort', onAbort)
  let r: ChatResult | undefined
  try { r = await child.result } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort); ctx.children.delete(child)
    // Recibos/skills so sobrevivem se a sessao nativa e comprovadamente a mesma: sessao nova = a informada; continuacao = a informada IGUAL a retomada.
    wire?.cleanup(!!r && (sid ? r.session === sid : !!r.session))
    if (a.mode === 'edit') d.guard.release(ctx.cwd, id)
  }

  // O que mudou na pasta (e se o modo leitura foi realmente respeitado).
  const after = snapshot(ctx.cwd)
  const changed = before && after ? diffSnap(before, after) : null
  const outOfScope = changed && scope.length ? changed.filter(f => !inScope(f, scope)) : []
  const violation = a.mode === 'read' && !!changed?.length
  const status = timedOut ? 'failed' : r.status
  const error = timedOut ? `Tempo limite de ${s.timeoutMin} min esgotado; a delegacao foi cancelada.` : r.error
  const answer = r.answer?.trim() || r.text // evento final nativo quando a CLI o marca; senao o ultimo texto do agente (answerBasis)
  const conclusion = extractConclusion(answer) // bloco final delimitado (regra local); ausente/ambiguo = extrato rotulado
  const concluded = conclusion.kind === 'block' ? conclusion.text : answer
  if (r.session ?? sid) bindGrantSession(d.db, grant, (r.session ?? sid)!) // a continuacao legitima (mesma sessao) reencontra este grant
  const art = saveArtifact(d.db, {
    taskId: ctx.taskId, delegationId: id, producer: lineage, readers: [ctx.auth.authId, grant.authId], kind: 'delegation', title: `Delegacao #${id} (${a.provider})`,
    content: r.text || '(sem texto)', scope, meta: { status, answerBasis: r.answerBasis ?? null, tools: r.tools?.length ?? null }
  })
  const ex = excerpt(concluded, lim.conclusionChars)
  d.db.prepare("UPDATE delegations SET status=?, result=?, error=?, category=?, session_id=?, changed_files=?, out_of_scope=?, consumed=?, artifact_id=?, ended_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(status, ex.text, error ?? null, timedOut ? 'unknown' : r.category ?? null, r.session ?? sid ?? null,
      changed ? JSON.stringify(changed.slice(0, 200)) : null, JSON.stringify(outOfScope.slice(0, 200)),
      r.metric ? JSON.stringify({ in: r.metric.consumedIn ?? null, out: r.metric.consumedOut ?? null, scope: r.metric.scope ?? null }) : null, art.id, id)
  ctx.fails.set(a.provider, status === 'failed' ? (ctx.fails.get(a.provider) ?? 0) + 1 : 0)
  // Entrega confirmada so quando o filho concluiu; envio interrompido fica 'sent' (incerto) e o pacote nao e tratado como entregue.
  for (const dv of deliveries) {
    if (status === 'completed') { finishDelivery(d.db, dv.id, 'confirmed', r.session ?? sid); if (r.session ?? sid) bindSession(d.db, dv.x.pkg.id, (r.session ?? sid)!) }
  }
  try { // contabilidade e checkpoint sao extras: nunca derrubam a delegacao
    recordUsage(d.db, {
      taskId: ctx.taskId, delegationId: id, provider: a.provider, profile: recipient.profile, model: a.model, effort: a.effort, session: r.session ?? sid, sessionWasNew: !sid, metric: r.metric,
      promptChars: input.length, contextChars: packageText.length, resultChars: r.text.length, toolCalls: r.tools?.length, retries: r.retries, durationMs: r.durationMs
    })
    if (status === 'completed') {
      addMemory(d.db, { taskId: ctx.taskId, owner: 'delegation', originId: id, lineage: ctx.lineage, grantId: ctx.auth.authId, kind: 'finding', title: `Delegacao #${id} (${a.provider}) concluida`,
        content: findingContent({ objective: a.objective, changed, outOfScope, conclusion, artifactId: art.id, maxChars: lim.itemChars }),
        paths: scope, evidence: { artifacts: [art.id] } })
      buildCheckpoint(d.db, ctx.taskId, ctx.lineage, ctx.auth.authId)
    }
  } catch {}

  const flagsText = [outOfScope.length ? `FORA DO ESCOPO: ${outOfScope.slice(0, 5).join(', ')}` : '', violation ? 'ATENCAO: o modo leitura alterou arquivos' : ''].filter(Boolean).join(' · ')
  const filesText = changed === null ? 'nao foi possivel acompanhar (pasta muito grande)' : changed.length ? `${changed.length}: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? '…' : ''}` : 'nenhum'
  d.note(ctx.taskId, `↳ Delegacao #${id} ${PT[status]} · arquivos alterados: ${filesText}${flagsText ? ` · ${flagsText}` : ''}${error ? ` · ${clip(error, 300)}` : ''}\n\n${clip(concluded, 1500)}${concluded.length > 1500 ? `\n\n(extrato; detalhes completos no artefato #${art.id})` : ''}`)
  const text = buildEnvelope({
    id, status, answer, conclusion, answerBasis: r.answerBasis, error, category: timedOut ? 'unknown' : r.category, changed, outOfScope, violation,
    artifactId: art.id, totalChars: art.size, toolCount: r.tools?.length ?? 0, conclusionChars: lim.conclusionChars,
    sessionNote: a.continuationOf ? `continuacao da #${a.continuationOf}` : undefined
  })
  return { text, isError: status !== 'completed' }
}

// Fato do pai ao concluir uma delegacao: ordem, arquivos e, havendo bloco [CONCLUSAO] delimitado, o proprio bloco (ate CONCLUSION_IN_FINDING),
// para que consultas seguintes (e um pacote aprovado para outro destino, que nao le o artefato) nao precisem reabrir o artefato so pela conclusao.
// Narrativa sem bloco nao entra (nao e conclusao). O total cabe em maxChars (limite por item do pacote): senao o item inteiro ficaria de fora.
export const CONCLUSION_IN_FINDING = 1200
export function findingContent(o: { objective: string; changed: string[] | null; outOfScope: string[]; conclusion: Conclusion; artifactId: number; maxChars: number }): string {
  const head = `Ordem: ${clip(o.objective, 300)}\nArquivos alterados: ${o.changed === null ? 'nao acompanhado' : o.changed.length ? clip(o.changed.slice(0, 20).join(', '), 600) : 'nenhum'}${o.outOfScope.length ? `\nFORA DO ESCOPO: ${clip(o.outOfScope.join(', '), 300)}` : ''}`
  const tail = `\nResultado completo: artefato #${o.artifactId}`
  const label = '\nConclusao do filho:\n', more = ' (continua no artefato)'
  const room = Math.min(CONCLUSION_IN_FINDING, o.maxChars - head.length - tail.length - label.length - more.length)
  const body = o.conclusion.kind === 'block' && room >= 200 ? `${label}${clip(o.conclusion.text, room)}${o.conclusion.text.length > room ? more : ''}` : ''
  return `${head}${body}${tail}`
}

// Execucoes que ficaram 'running' quando o app fechou/caiu. Pedidos de aprovacao pendentes de delegacoes tambem expiram
// (aprovar depois nao pode iniciar um processo orfao).
export function reconcileDelegations(db: DatabaseSync) {
  invalidatePending(db, { reason: 'app reiniciado antes da decisao', delegationBound: true })
  return Number(db.prepare("UPDATE delegations SET status='failed', error='Delegacao interrompida: o app foi fechado antes de terminar.', category='unknown', ended_at=CURRENT_TIMESTAMP WHERE status IN ('running','awaiting_context_approval')").run().changes)
}

// ---- Como cada provedor enxerga as ferramentas (sem tocar em configuracoes globais)
export type McpWire = { extra: string[]; env: Record<string, string>; cleanup: () => void }
const QUOTE_OK = /^[^"%^&|<>\r\n]+$/
export function mcpWire(provider: string, o: { url: string; token: string; timeoutSec: number; dir: string; tools?: string[]; permission?: boolean }): McpWire | null {
  const noop = () => {}
  if (provider === 'codex')
    return {
      extra: ['-c', `mcp_servers.dashboard.url=${o.url}`, '-c', 'mcp_servers.dashboard.bearer_token_env_var=DASHBOARD_MCP_TOKEN', '-c', `mcp_servers.dashboard.tool_timeout_sec=${o.timeoutSec}`],
      env: { DASHBOARD_MCP_TOKEN: o.token }, cleanup: noop
    }
  if (provider === 'opencode')
    return {
      extra: [], cleanup: noop,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { dashboard: { type: 'remote', url: o.url, headers: { Authorization: `Bearer ${o.token}` }, enabled: true, timeout: o.timeoutSec * 1000 } } }) }
    }
  if (provider === 'claude') {
    fs.mkdirSync(o.dir, { recursive: true })
    const file = path.join(o.dir, `mcp-${o.token.slice(0, 12)}.json`)
    if (!QUOTE_OK.test(file)) return null
    // timeout (ms) por servidor: sem ele o Claude aborta a ferramenta HTTP apos 300 s sem resposta ("idle timeout", separado de MCP_TOOL_TIMEOUT),
    // e um filho lento (ex.: esforco max) e cancelado no meio. Vale so para este servidor; nada global muda.
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { dashboard: { type: 'http', url: o.url, headers: { Authorization: `Bearer ${o.token}` }, timeout: o.timeoutSec * 1000 } } }), { mode: 0o600 })
    // Em headless o Claude nao pergunta: sem isto a chamada da ferramenta MCP e negada. Libera SO as ferramentas anunciadas ao papel
    // (que aplicam os proprios limites); nenhuma outra permissao e ampliada.
    // permission: o pop-up do dashboard responde as permissoes do modo headless (--permission-prompt-tool); a propria ferramenta de pergunta nao pede permissao.
    const allowed = [...(o.tools ?? [TOOL_NAME]), ...(o.permission ? ['permission_prompt'] : [])].map(t => `mcp__dashboard__${t}`)
    // Caminho SEM aspas: cliSpawn so as poe quando roda pelo cmd.exe (claude.cmd); claude.exe (ou Linux) as receberia literais e recusaria a configuracao.
    return { extra: ['--mcp-config', file, ...(o.permission ? ['--permission-prompt-tool', 'mcp__dashboard__permission_prompt'] : []), '--allowedTools', ...allowed], env: { MCP_TOOL_TIMEOUT: String(o.timeoutSec * 1000) }, cleanup: () => { try { fs.rmSync(file, { force: true }) } catch {} } }
  }
  return null // gemini: a CLI so le servidores MCP de arquivos de configuracao (global ou do projeto); nao alteramos esses arquivos
}

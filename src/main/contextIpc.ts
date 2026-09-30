// IPC do contexto da tarefa: pedidos de aprovacao e mensagens retidas, permissoes dos agentes, memoria, artefatos, uso e imagens.
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { AGENTS } from './adapters.ts'
import { approveSubset, deliveryCounts, getPackage, listPackages, resolvePackage, revokePackage, type ApprovalWaiters, type Decision } from './consent.ts'
import { listSends, recoverSend } from './sends.ts'
import { addRule, assessRule, listRules, normalizePermissionSettings, removeRule, type Decision as PermDecision, type PermissionBroker } from './permissions.ts'
import { listArtifacts, readArtifact } from './artifacts.ts'
import { readImage } from './attachments.ts'
import { searchMemory, validate, type EvidenceReads } from './memory.ts'
import { taskUsage } from './usage.ts'
import { asInt, asStr, fail } from './guard.ts'
import type { ContextLimits } from './limits.ts'
import type { Task } from './tasks.ts'

const asKeep = (v: unknown): string[] | undefined => (v == null ? undefined : Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === 'string' && x.length <= 200) ? (v as string[]) : fail('Selecao de itens invalida.'))

export function contextHandlers(d: {
  db: DatabaseSync; asTask: (v: unknown) => Task; asGame: (v: unknown) => string; taskCwd: (t: Task) => Promise<string>; emit: (ev: object) => void
  decideSend: (id: number, hash: string, decision: Decision, keep?: string[]) => Promise<unknown>
  contextLimits: () => ContextLimits; waiters: ApprovalWaiters; broker: PermissionBroker
  permissionSettings: () => ReturnType<typeof normalizePermissionSettings>; setSetting: (k: string, v: string) => void; attachRoot: string
}) {
  const { db, asTask, asGame, taskCwd, emit, decideSend, contextLimits, waiters, broker, permissionSettings, setSetting, attachRoot } = d
  return {
    // ---- Contexto da tarefa: pedidos de aprovacao, memoria, artefatos, uso e limites. A aprovacao e validada AQUI (ID + hash do que foi exibido);
    // o renderer nao informa escopo, destinatario nem conteudo.
    // Cada pacote traz o estado de CONSENTIMENTO (state) e o de ENTREGA (delivery: confirmadas/enviadas sem confirmacao/falhas) separados.
    listContextPackages: (taskId: number) => listPackages(db, asTask(taskId).id).map(p => ({ ...p, delivery: deliveryCounts(db, p.id) })),
    // Mensagens retidas aguardando decisao (e as canceladas/expiradas ainda nao recuperadas, com o texto guardado).
    listPendingSends: (taskId: number) => listSends(db, asTask(taskId).id),
    decideSend: (id: number, hash: string, decision: string, keep?: unknown) => decideSend(asInt(id, 'envio'), asStr(hash, 'hash', 128), decision as Decision, asKeep(keep)),
    recoverSend: (id: number) => recoverSend(db, asInt(id, 'envio')),
    resolveContextPackage: (id: number, hash: string, decision: string, keep?: unknown) => {
      const pkg = getPackage(db, asInt(id, 'pedido')) ?? fail('Pedido de contexto inexistente.')
      if (db.prepare("SELECT 1 FROM pending_sends WHERE package_id=? AND state='awaiting_context_approval'").get(pkg.id)) fail('Este pedido pertence a uma mensagem retida: decida pelo cartao do envio (aprovar e executar, executar sem contexto ou cancelar).')
      const subset = decision === 'approve' ? asKeep(keep) : undefined
      const r = subset ? approveSubset(db, contextLimits(), { id: pkg.id, hash: asStr(hash, 'hash', 128), keep: subset })
        : resolvePackage(db, { id: pkg.id, hash: asStr(hash, 'hash', 128), decision: decision as Decision })
      waiters.resolved(pkg.id, r.pkg.state) // acorda a delegacao que espera (aprovar, continuar sem contexto ou cancelar); em parte, ela segue o subconjunto
      emit({ taskId: pkg.task_id, contextResolved: pkg.id, state: r.pkg.state, refresh: true })
      return { state: r.pkg.state, already: r.already }
    },
    // Revogar impede envios FUTUROS; o que o provedor ja recebeu nao e apagado (para continuar sem ele, use uma sessao nova).
    revokeContextPackage: (id: number) => {
      const pkg = getPackage(db, asInt(id, 'pacote')) ?? fail('Pacote inexistente.')
      return revokePackage(db, pkg.id, pkg.task_id)
    },
    // ---- Permissoes dos agentes: pop-up (pedidos do Claude), regras "sempre permitir/negar" e politica nativa de Codex/OpenCode.
    listPermissionRequests: (taskId?: number) => broker.list({ taskId: taskId == null ? undefined : asTask(taskId).id }),
    resolvePermissionRequest: (id: number, decision: string, opt: any) =>
      broker.resolve(asInt(id, 'pedido'), decision as PermDecision, { pattern: typeof opt?.pattern === 'string' ? opt.pattern.slice(0, 300) : undefined, project: opt?.project === true, acknowledged: opt?.acknowledged === true }),
    listPermissionRules: () => listRules(db),
    addPermissionRule: (r: any) => addRule(db, {
      provider: asStr(r?.provider, 'agente', 30), kind: asStr(r?.kind, 'tipo', 10), pattern: asStr(r?.pattern, 'padrao', 300), decision: r?.decision,
      project: r?.project ? asGame(r.project) : '', acknowledged: r?.acknowledged === true
    }, Object.keys(AGENTS)),
    removePermissionRule: (id: number) => removeRule(db, asInt(id, 'regra')),
    assessPermissionRule: (kind: string, pattern: string) => assessRule(kind === 'tool' ? 'tool' : 'bash', asStr(pattern, 'padrao', 300)),
    // capabilities: como cada CLI responde permissoes. claude = pop-up; codex/opencode = politica nativa (sem prompt no modo headless); gemini fora.
    getPermissionSettings: () => ({ ...permissionSettings(), capabilities: { claude: 'prompt', codex: 'sandbox', opencode: 'auto-e-regras' } }),
    setPermissionSettings: (raw: any) => {
      const n = normalizePermissionSettings(raw)
      if (n.codexSandbox === 'danger-full-access' && permissionSettings().codexSandbox !== 'danger-full-access' && raw?.acknowledged !== true)
        fail('Codex sem sandbox executa qualquer comando sem restricao. Confirme que entende o risco para salvar.')
      setSetting('permissions', JSON.stringify(n))
      return n
    },
    taskUsage: (taskId: number) => taskUsage(db, asTask(taskId).id),
    taskMemory: async (taskId: number) => {
      const t = asTask(taskId)
      let cwd: string | null = null
      try { cwd = await taskCwd(t) } catch {}
      const seen: EvidenceReads = new Map()
      return searchMemory(db, { taskId: t.id, limit: 500, state: undefined }).items.map(m => ({ ...m, validity: cwd ? validate(db, m, cwd, seen).validity : 'unknown' }))
    },
    listTaskArtifacts: (taskId: number) => listArtifacts(db, asTask(taskId).id),
    readTaskArtifact: (taskId: number, id: number, offset?: number) =>
      readArtifact(db, { taskId: asTask(taskId).id, reader: '', id: asInt(id, 'artefato'), offset: Number.isSafeInteger(offset) ? offset : 0, limit: contextLimits().queryChars, asUser: true }),
    taskImage: async (taskId: number, p: string) => {
      const t = asTask(taskId)
      let cwd: string | null = null
      try { cwd = await taskCwd(t) } catch {}
      return readImage(asStr(p, 'caminho', 2000), [...(cwd ? [cwd] : []), path.join(attachRoot, String(t.id))])
    },
  }
}

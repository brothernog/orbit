// Execução de chat e consentimento. Estado por instância; sem importar Electron.
import type { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { AGENTS, type Metric } from './adapters.ts'

import { fail } from './guard.ts'
import { delegateTool, mcpWire, normalizeSettings, WorkspaceGuard, type ParentCtx } from './delegation.ts'
import { approveSubset, bindGrantSession, bindSession, finishDelivery, getPackage, invalidatePending, openGrant, planHistoryContext, recordDelivery, renderPackage, resolvePackage, type Decision, type Recipient } from './consent.ts'
import { awaitingSend, AWAITING_MSG, createSend, endSend, getSend, moveSend, scheduleExpiry } from './sends.ts'
import { normalizeLimits } from './limits.ts'
import { imagesIn } from './attachments.ts'
import { selectContext } from './contextSelect.ts'

import { newToken } from './mcp.ts'
import { nativePolicy, normalizePermissionSettings, PermissionBroker } from './permissions.ts'
import { CHAT_IMAGES_HINT, runtimeBrief } from './prompt.ts'
import { runChat } from './runner.ts'
import { toolsFor } from './taskContext.ts'
import { recordUsage } from './usage.ts'
import { finishRun, savePartial, startRun } from './runs.ts'
import { readSkill } from './skills.ts'

import { autoTitle, contextFor, getTask, profileOf, saveSel, saveSession, sessionOf, type TaskSel } from './tasks.ts'
import type { LogEntry } from './providers.ts'

type Sel = TaskSel
export type ActiveRun = { runId: number; cancel: (sync?: boolean) => void; text: string; workspace: string; provider?: string; model?: string; startedAt?: number; doing?: { tool: string; detail?: string } }
type ChatDeps = {
  db: DatabaseSync; active: Map<number, ActiveRun>; guard: WorkspaceGuard; broker: PermissionBroker; workspaceBusy: (cwd: string) => boolean
  asTask: (id: number) => ReturnType<typeof getTask>; taskCwd: (t: ReturnType<typeof getTask>) => string
  checkSel: (sel: Sel) => Promise<void>; contextLimits: () => ReturnType<typeof normalizeLimits>
  delegationSettings: () => ReturnType<typeof normalizeSettings>; permissionSettings: () => ReturnType<typeof normalizePermissionSettings>
  getMcp: () => Promise<{ url: string }>; mcpDir: () => string; nativeFor: (provider: string) => ReturnType<typeof nativePolicy>
  envFor: (sel: Sel) => NodeJS.ProcessEnv; emit: (ev: object) => void; note: (taskId: number, text: string) => void
  logFor: (provider: string, profile?: string) => (e: Partial<LogEntry>) => void
  accountRow: (id?: number | null) => { name: string } | null; setSetting: (key: string, value: string) => unknown
  recordMetric: (taskId: number, sel: Sel, profile: string, session: string | undefined, metric: Metric | undefined) => void
  registerParent: (token: string, parent: ParentCtx, perm: boolean) => void; unregisterToken: (token: string) => void
  attachRoot: string; linkedinDir: string
}
export function createChatService(d: ChatDeps) {
  const { db, active, guard, broker, asTask, taskCwd, checkSel, contextLimits, delegationSettings, permissionSettings,
    getMcp, mcpDir, nativeFor, envFor, emit, note, logFor, accountRow, setSetting, recordMetric, registerParent, unregisterToken, attachRoot, linkedinDir } = d
    const sameDir = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    const pct = (w: any) => w && { utilization: w.utilization * 100, resets_at: new Date(w.resetsAt * 1000).toISOString() }
  // Envios retidos aguardando decisao sobre contexto: cada um tem um prazo (so EXPIRA, nunca inicia a execucao).
  const sendTimers = new Map<number, NodeJS.Timeout>()
  type SendResult = { status: 'started'; runId: number } | { status: 'awaiting_context_approval'; sendId: number; packageId: number }

  // fromSend: a decisao do usuario sobre um envio retido ja foi tomada; a execucao usa o destino e o texto guardados no envio.
  async function sendTask(taskId: number, sel: Sel, text: string, fromSend?: number): Promise<SendResult> {
    const t = asTask(taskId)
    if (active.has(t.id)) throw new Error('O agente ainda esta respondendo nesta tarefa.')
    if (!fromSend && awaitingSend(db, t.id)) throw new Error(AWAITING_MSG)
    taskCwd(t) // falha cedo se o projeto nao for permitido
    await checkSel(sel)
    if (active.has(t.id)) throw new Error('O agente ainda esta respondendo nesta tarefa.') // outra mensagem entrou durante a consulta ao catalogo
    if (!fromSend && awaitingSend(db, t.id)) throw new Error(AWAITING_MSG)
    const cwd = taskCwd(t)
    const requireIdle = () => {
      if (active.has(t.id)) throw Error('O agente ainda esta respondendo nesta tarefa.')
      if (d.workspaceBusy(cwd)) throw Error('Aguarde ou cancele o comando local nesta pasta antes de enviar ao agente.')
      const blocked = guard.blockedFor(cwd, t.id)
      if (blocked) throw Error(blocked)
    }
    requireIdle()
    const a = AGENTS[sel.provider]
    const profile = profileOf(sel.provider, sel.accountId)
    const sid = sessionOf(db, t.id, sel.provider, profile)
    const lineage = `chat:${t.id}:${sel.provider}:${profile}` // conversa: identifica o destino logico; a autorizacao vem do grant (abaixo)
    // Contexto de que esta mensagem DEPENDE. Historico anterior so segue com pacote APROVADO para este destino exato. Havendo um pedido pendente
    // (novo ou ja existente), a mensagem fica RETIDA: nenhum processo, token, arquivo temporario ou mensagem de usuario e criado antes da decisao.
    const lim = contextLimits()
    const recipient: Recipient = { logicalId: lineage, provider: sel.provider, profile, model: sel.model ?? null, effort: sel.effort ?? null, workspace: cwd, scope: [] }
    // Candidato deterministico (sem IA): memoria pertinente das conversas da tarefa (requisitos, decisoes, pendencias, evidencias validas) + historico bruto
    // so como complemento; o que nao couber vai para o pedido como "nao incluido". ANTES de gravar a mensagem nova.
    const selection = selectContext(db, { taskId: t.id, recipient, sessionId: sid ?? null, cwd, limits: lim, history: max => contextFor(db, t.id, sel.provider, sel.accountId, !!sid, max) })
    const plan = planHistoryContext(db, lim, { taskId: t.id, recipient, sessionId: sid ?? null, candidate: selection.candidate })
    if (plan.pending) {
      if (fromSend) { // a decisao foi tomada mas o destino mudou (worktree, conta, modelo...): outro pedido, nada inicia com o pacote errado
        endSend(db, fromSend, 'cancelled', 'o destino mudou desde o pedido: um novo pedido e necessario')
        throw new Error('O destino mudou desde a sua decisao (pasta, conta, modelo ou sessao): nada foi enviado. Envie a mensagem de novo para decidir sobre o novo pedido.')
      }
      a.chatArgs(sid, { model: sel.model, effort: sel.effort }) // valida ids antes de reter a mensagem
      saveSel(db, t.id, sel)
      let send: ReturnType<typeof createSend>
      try { send = createSend(db, { taskId: t.id, packageId: plan.pending.id, text, sel }) }
      catch (e) { if (plan.created) invalidatePending(db, { id: plan.pending.id, state: 'cancelled', reason: 'envio nao retido' }); throw e }
      sendTimers.set(send.id, scheduleExpiry(db, send.id, lim.approvalTimeoutMin * 60_000, s => {
        sendTimers.delete(s.id)
        note(s.task_id, `↳ Mensagem NAO enviada: sem decisao sobre o contexto em ${lim.approvalTimeoutMin} min. Nenhum agente foi iniciado; o texto foi guardado e pode ser recuperado.`)
        emit({ taskId: s.task_id, contextResolved: s.package_id, state: 'expired', refresh: true })
      }))
      note(t.id, `↳ Mensagem retida para ${sel.provider}${sel.model ? `/${sel.model}` : ''}: aguarda a sua decisao sobre o contexto anterior (pedido #${plan.pending.id}). Nenhum agente foi iniciado e nada foi enviado.`)
      emit({ taskId: t.id, contextRequest: plan.pending.id, refresh: true })
      return { status: 'awaiting_context_approval', sendId: send.id, packageId: plan.pending.id }
    }
    // Ferramenta de delegacao: so nas execucoes do usuario e so nos provedores cujo cliente MCP aceita configuracao por execucao.
    const ds = delegationSettings()
    let wire = null as ReturnType<typeof mcpWire>
    let token = ''
    const pset = permissionSettings()
    const perm = sel.provider === 'claude' && pset.prompt // Claude: as permissoes do modo headless vao ao pop-up do dashboard
    if (ds.enabled || perm) {
      try {
        token = newToken()
        // O pai pode esperar a aprovacao humana antes de o filho comecar (e o usuario responder um pedido de permissao): o timeout do cliente MCP cobre tudo.
        const timeoutSec = (ds.timeoutMin + Math.max(contextLimits().approvalTimeoutMin, pset.timeoutMin)) * 60 + 60
        wire = mcpWire(sel.provider, { url: (await getMcp()).url, token, timeoutSec, dir: mcpDir(), tools: toolsFor('parent', ds.enabled ? delegateTool() : undefined).map(x => x.name), permission: perm })
      } catch (e: any) { // a delegacao e um extra: se o servidor local nao subir, a conversa segue sem a ferramenta
        logFor('app')({ category: 'config', detail: `ferramenta de delegacao indisponivel: ${e?.message}` })
      }
    }
    // MCP é assíncrono: um comando/execução pode reservar a pasta durante sua preparação.
    try { requireIdle() } catch(e) { wire?.cleanup(); throw e }
    // Politica nativa do "sempre permitir" (Codex: sandbox/rede; OpenCode: --auto e regras). Claude pergunta pelo pop-up (acima).
    const np = nativeFor(sel.provider)
    const extra = [...(wire?.extra ?? []), ...(np.opts.extra ?? [])]
    const images = imagesIn(text, attachRoot) // marcadores da propria mensagem (tambem na retida, que volta so com o texto)
    const args = a.chatArgs(sid, { images, model: sel.model, effort: sel.effort, sandbox: np.opts.sandbox, network: np.opts.network, permissionMode: np.opts.permissionMode, ...(extra.length ? { extra } : {}) }) // valida ids antes de gravar qualquer coisa
    const permEnv: Record<string, string> = {}
    if (sel.provider === 'opencode' && np.permission) { // uma unica variavel de configuracao: mescla as regras com o MCP
      const base = wire?.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(wire.env.OPENCODE_CONFIG_CONTENT) : {}
      permEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...base, permission: np.permission })
    }
    saveSel(db, t.id, sel) // a escolha fica na tarefa; esta execucao mantem a configuracao com que comecou
    // Identidade efetiva da execucao (autoriza toda leitura de memoria/artefatos pelas ferramentas MCP): mesma sessao + mesmo destinatario = mesma identidade;
    // sessao nova recebe uma interna e o backend a vincula ao ID nativo quando o executor o informar (onSession).
    const grant = openGrant(db, { taskId: t.id, recipient, sessionId: sid ?? null })
    const dctx: ParentCtx = { taskId: t.id, runId: 0, provider: sel.provider, accountId: sel.accountId, cwd, lineage, auth: grant, depth: 0, fails: new Map(), children: new Set() }
    const pkgText = plan.deliver.length ? renderPackage(plan.deliver.flatMap(x => x.items), { uncertain: plan.deliver.some(x => x.uncertain) }) : ''
    const first = !sid && !(db.prepare("SELECT 1 FROM messages WHERE task_id=? AND role='user'").get(t.id))
    const pin = first && t.pin_id ? (db.prepare('SELECT * FROM pins WHERE id=?').get(t.pin_id) as any) : null
    const brief = wire && !sid ? runtimeBrief({ memoryTools: true, workspaceTools: false, skills: 'parent' }) : '' // regras curtas so na sessao nova: a sessao as retem
    // Pagina LinkedIn: a skill vai inteira na sessao nova (e o unico assunto dali); a pasta atual e a mesa do agente.
    const li = !sid && sameDir(cwd, linkedinDir) ? `[Pagina LinkedIn do dashboard: a pasta atual e a sua mesa]\n${readSkill('linkedin').text}\n\n` : ''
    const input = [pin && `Resolva este problema do jogo. ${pin.title}. ${pin.body ?? ''}\n\n`, !sid && `${CHAT_IMAGES_HINT}\n\n`, brief && `${brief}\n\n`, li, pkgText && `${pkgText}\n\n`, text].filter(Boolean).join('')
    const notice = [
      plan.deliver.length ? `Contexto aprovado (${plan.deliver.reduce((n, x) => n + x.items.length, 0)} item(ns)) enviado para ${sel.provider} (${sid ? 'sessao existente' : 'sessao nativa nova'}).` : '',
      plan.error ? `Historico anterior nao foi enviado: nao foi possivel montar o pedido de aprovacao. ${plan.error}` : ''
    ].filter(Boolean).join('\n') || undefined
    const runId = startRun(db, { taskId: t.id, provider: sel.provider, accountId: sel.accountId, model: sel.model, effort: sel.effort }, text, notice)
    autoTitle(db, t.id, text)
    const deliveries = plan.deliver.map(x => ({ x, id: recordDelivery(db, x.pkg, sid ?? '', x.items) }))
    const entry = { runId, cancel: (_sync?: boolean) => {}, text: '', workspace: cwd, provider: sel.provider, model: sel.model, startedAt: Date.now(), doing: undefined as { tool: string; detail?: string } | undefined }
    dctx.runId = runId
    if (wire) registerParent(token, dctx, perm)
    let lastSave = 0
    const run = runChat({
      cmd: a.cmd, args, cwd, env: { ...envFor(sel), ...wire?.env, ...permEnv }, parse: a.parse,
      input, // a mensagem vai pelo stdin, nunca na linha de comando
      onTool: (tool, detail) => { entry.doing = { tool: tool.slice(0, 80), detail } },
      maxTools: contextLimits().maxToolsPerMessage, // so a mensagem do usuario; filhos delegados ja tem timeout proprio
      onSession: id => { saveSession(db, t.id, sel.provider, profile, id); bindGrantSession(db, grant, id) },
      onText: full => {
        entry.text = full
        emit({ taskId: t.id, text: full })
        if (Date.now() - lastSave > 1000) { lastSave = Date.now(); savePartial(db, runId, full) }
      },
      // Medidor ao vivo: so o contexto ocupado (e a janela, se ja veio); a medida completa e gravada no fim (recordMetric).
      onMetric: m => { if (m.occupied != null) emit({ taskId: t.id, metric: { occupied: m.occupied, capacity: m.capacity ?? null, estimated: !!m.estimated, source: m.source } }) },
      onUsage: data => {
        if (data?.five_hour) setSetting(`usage:${sel.accountId}`, JSON.stringify({ fiveHour: pct(data.five_hour), sevenDay: pct(data.seven_day) }))
      }
    })
    entry.cancel = sync => { for (const c of dctx.children) c.cancel(sync); run.cancel(sync) } // cancelar o pai cancela os filhos
    active.set(t.id, entry)
    run.result.then(r => {
      active.delete(t.id)
      unregisterToken(token)
      wire?.cleanup()
      for (const c of dctx.children) c.cancel()
      finishRun(db, runId, r)
      try { broker.expire({ runId }) } catch {} // pedidos de permissao pendentes desta execucao perdem o sentido
      try { recordMetric(t.id, sel, profile, r.session ?? sid, r.metric) } catch {} // medida e opcional: nunca derruba a execucao
      try { // contabilidade: so numeros (sem prompt nem texto); campo que o provedor nao informou fica NULL
        recordUsage(db, { taskId: t.id, runId, provider: sel.provider, profile, model: sel.model, effort: sel.effort, session: r.session ?? sid, sessionWasNew: !sid, metric: r.metric,
          promptChars: input.length, contextChars: pkgText.length, resultChars: r.text.length, toolCalls: r.tools?.length, retries: r.retries, durationMs: r.durationMs })
      } catch {}
      try { // entrega confirmada so se a execucao concluiu; senao fica 'sent' (incerta) e o pacote sera reenviado avisando isso
        const done = r.session ?? sid
        for (const dv of deliveries) {
          if (r.status === 'completed') { finishDelivery(db, dv.id, 'confirmed', done); if (done) bindSession(db, dv.x.pkg.id, done) }
          else if (r.category === 'command') finishDelivery(db, dv.id, 'failed') // a CLI nem chegou a iniciar: falhou, o pacote nao foi entregue
        }
        invalidatePending(db, { parentRunId: runId, state: 'cancelled', reason: 'a execucao do agente pai terminou' }) // aprovar depois nao inicia nada
      } catch {}
      if (r.status === 'failed') {
        logFor(sel.provider, sel.provider === 'claude' ? accountRow(sel.accountId)?.name : undefined)({ cwd, args, code: r.code, category: r.category, detail: r.error })
        setSetting(`lastError:${sel.provider}`, JSON.stringify({ at: new Date().toISOString(), code: r.code, category: r.category, detail: (r.error ?? '').slice(0, 300) }))
      } else if (r.status === 'completed') {
        db.prepare('DELETE FROM settings WHERE key=?').run(`lastError:${sel.provider}`) // uma execucao bem-sucedida resolve a falha antiga do painel Provedores
      }
      emit({ taskId: t.id, done: true })
    })
    return { status: 'started', runId }
  }

  // Decisao do usuario sobre uma mensagem retida (ID do envio + hash do pacote que a interface exibiu; o destino e o texto vem do envio guardado,
  // nunca da tela). approve = aprovar e executar; reject = executar sem contexto (recusa); cancel = cancelar o envio (nada inicia; texto recuperavel).
  // keep: aprovar SO estes itens (refs) do pedido exibido; o subconjunto vira um pacote novo ja aprovado (consent.approveSubset).
  async function decideSend(sendId: number, hash: string, decision: Decision, keep?: string[]) {
    const s = getSend(db, sendId) ?? fail('Envio inexistente.')
    if (!['approve', 'reject', 'cancel'].includes(decision)) fail('Decisao invalida.')
    if (s.state !== 'awaiting_context_approval') {
      if (s.decision === decision && ['starting', 'sent'].includes(s.state)) return { already: true, state: s.state } // clique repetido: inofensivo
      fail(`Este envio ja foi resolvido (${s.state}); a decisao nao pode ser trocada.`)
    }
    const pkg = s.package_id ? getPackage(db, s.package_id) : null
    if (decision === 'cancel') {
      if (!endSend(db, s.id, 'cancelled', 'cancelado pelo usuario')) return { already: true, state: getSend(db, s.id)?.state }
      clearTimeout(sendTimers.get(s.id)); sendTimers.delete(s.id)
      emit({ taskId: s.task_id, contextResolved: s.package_id, state: 'cancelled', refresh: true })
      note(s.task_id, '↳ Envio cancelado: nenhum agente foi iniciado. O texto da mensagem foi guardado e pode ser recuperado.')
      return { state: 'cancelled' }
    }
    if (!pkg) fail('Pedido de contexto inexistente.')
    const r = decision === 'approve' && keep ? approveSubset(db, contextLimits(), { id: pkg!.id, hash, keep }) // valida ID + hash do que foi exibido e o conteudo gravado
      : resolvePackage(db, { id: pkg!.id, hash, decision: decision as Decision })
    if (!moveSend(db, s.id, 'awaiting_context_approval', 'starting', { decision })) return { already: true, state: getSend(db, s.id)?.state }
    clearTimeout(sendTimers.get(s.id)); sendTimers.delete(s.id)
    emit({ taskId: s.task_id, contextResolved: pkg!.id, state: r.pkg.state, refresh: true })
    let started: SendResult
    try { started = await sendTask(s.task_id, s.sel, s.text, s.id) }
    catch (e: any) { // nada iniciou: o envio fica cancelado com o motivo e o texto continua recuperavel
      moveSend(db, s.id, 'starting', 'cancelled', { reason: String(e?.message ?? e).slice(0, 300) })
      emit({ taskId: s.task_id, refresh: true })
      throw e
    }
    moveSend(db, s.id, 'starting', 'sent')
    return { state: 'sent', decision, ...(started.status === 'started' ? { runId: started.runId } : {}) }
  }

  return { sendTask, decideSend }
}

// Ferramentas MCP de contexto da tarefa: read_task_context (indice/itens/artefatos AUTORIZADOS), record_task_memory (registro com
// origem e evidencia, privado a linhagem) e as operacoes locais de area de trabalho/testes dos filhos.
// A tarefa e a linhagem vem do token autenticado, nunca de um ID informado pelo agente. Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'
import { listArtifacts, readArtifact } from './artifacts.ts'
import { authorizedPackages, type Grant } from './consent.ts'
import { lookupTestEvidence, recordTestEvidence } from './evidence.ts'
import { inScope } from './guard.ts'
import type { ContextLimits } from './limits.ts'
import { addMemory, fileEvidence, getMemory, KINDS, normalize, TODO_STATES, validate, type EvidenceReads, type MemoryRow } from './memory.ts'
import { loadSkill, READ_SKILL_TOOL_NAME, skillTool } from './skills.ts'
import type { EngineId } from './engines.ts'
import type { ToolDef, ToolResult } from './mcp.ts'
import { ASK_TOOL } from './questions.ts'
import { SUGGEST_TOOL } from './suggestions.ts'
import { SEND_FILE_TOOL } from './sharedFiles.ts'
import { findInWorkspace, readFileRange } from './workspaceTools.ts'

export type ToolCtx = {
  taskId: number
  lineage: string // 'chat:<tarefa>:<provedor>:<perfil>' (execucao do usuario) ou 'del:<delegacao raiz>' (filho): identifica a conversa, NAO autoriza leitura
  auth: Grant // identidade efetiva da execucao (tarefa + destinatario completo + sessao), criada pelo backend: e ela que autoriza toda leitura
  role: 'parent' | 'child'
  cwd: string
  scope: string[] // escopo da delegacao (filho); vazio = area inteira
  runId?: number; delegationId?: number
  provider?: string // provedor da execucao (usado nos pedidos de permissao do filho)
  engines?: EngineId[] // engines concedidas e revalidadas nesta consulta (skills de engine)
}

const obj = (properties: object, required: string[] = []) => ({ type: 'object', properties, required })
export const READ_CONTEXT_TOOL: ToolDef = {
  name: 'read_task_context',
  description: 'Contexto AUTORIZADO da tarefa (sua memoria, pacotes aprovados, artefatos). Sem itemId/artifactId: indice (IDs, titulos, trechos, validade); depois leia so o necessario.',
  inputSchema: obj({
    query: { type: 'string', description: 'Todos os termos.' }, kind: { type: 'string', enum: [...KINDS] }, path: { type: 'string', description: 'Caminho relativo.' },
    itemId: { type: 'string', description: 'Ex.: "m:12".' }, artifactId: { type: 'integer' }, offset: { type: 'integer', description: 'Pagina (caracteres).' },
    cursor: { type: 'string' }, limit: { type: 'integer' }, expand: { type: 'boolean', description: 'Pagina maior.' }
  })
}
export const RECORD_MEMORY_TOOL: ToolDef = {
  name: 'record_task_memory',
  description: 'Registra um fato curto da tarefa, com evidencia opcional. PRIVADO a sua linhagem ate o usuario aprovar compartilhar. Nao grave transcricoes.',
  inputSchema: obj({
    kind: { type: 'string', enum: [...KINDS] }, title: { type: 'string' }, content: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } },
    evidenceFiles: { type: 'array', items: { type: 'string' }, description: 'Arquivos que sustentam o fato (hash gravado).' },
    todoState: { type: 'string', enum: TODO_STATES }, deps: { type: 'array', items: { type: 'integer' } }, supersedes: { type: 'integer' }
  }, ['kind', 'title', 'content'])
}
export const FIND_TOOL: ToolDef = {
  name: 'find_in_workspace',
  description: 'Busca texto/regex ou lista arquivos na area de trabalho (barato, limitado). Devolve a contagem total e avisa quando truncou.',
  inputSchema: obj({ mode: { type: 'string', enum: ['search', 'list'] }, pattern: { type: 'string' }, regex: { type: 'boolean' }, path: { type: 'string' }, glob: { type: 'string' }, maxResults: { type: 'integer' } })
}
export const READ_RANGE_TOOL: ToolDef = {
  name: 'read_file_range',
  description: 'Le ate 400 linhas; a resposta traz readToken. Relendo o MESMO arquivo, envie o readToken que ainda esta no seu contexto: linhas ja entregues nao voltam. Sem token ou arquivo alterado: leitura inteira. Perdeu o trecho (compactacao)? Peca sem token.',
  inputSchema: obj({ path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, readToken: { type: 'string', description: 'De uma leitura anterior cujo conteudo voce ainda tem.' } }, ['path'])
}
export const TEST_EVIDENCE_TOOL: ToolDef = {
  name: 'test_evidence',
  description: 'record: registra o RELATO de um teste que voce rodou (fica agent_reported). lookup: consulta o MESMO comando neste diretorio; reusable=true so para execucao observada pelo dashboard com dependencias inalteradas. Seu relato nunca dispensa rodar o teste.',
  inputSchema: obj({
    action: { type: 'string', enum: ['record', 'lookup'] }, command: { type: 'string' }, exitCode: { type: 'integer' }, output: { type: 'string' }, durationMs: { type: 'integer' },
    inputs: { type: 'array', items: { type: 'string' }, description: 'Arquivos/pastas de que o teste depende.' }, hermetic: { type: 'boolean' }, network: { type: 'boolean' }, env: { type: 'string', description: 'Ex.: "win32 node 26".' }
  }, ['action', 'command'])
}
// Ferramentas anunciadas por papel. Pai: consulta/registro de contexto, perguntar ao usuario e sugerir tarefa (mais delegar, acrescentado
// pelo chamador; ask_user/suggest_task/send_user_file sao atendidas em index.ts). Filho responde ao pai: nunca pergunta nem sugere ao usuario.
// Filho: alem disso, operacoes locais. Nunca delegar_to_agent para filho (a recursao tambem e barrada no backend).
// read_task_skill: instrucoes detalhadas sob demanda, com a lista do que o PAPEL pode consultar (pai: delegacao e memoria; filho: so memoria).
export const toolsFor = (role: 'parent' | 'child', delegate?: ToolDef, engines: readonly EngineId[] = []): ToolDef[] =>
  role === 'parent' ? [...(delegate ? [delegate] : []), READ_CONTEXT_TOOL, RECORD_MEMORY_TOOL, skillTool('parent', engines), ASK_TOOL, SUGGEST_TOOL, SEND_FILE_TOOL] : [READ_CONTEXT_TOOL, RECORD_MEMORY_TOOL, FIND_TOOL, READ_RANGE_TOOL, TEST_EVIDENCE_TOOL, skillTool('child', engines)]

// Ferramentas do filho por provedor e modo, sem pagar duas vezes pela mesma capacidade. O Claude ja tem busca nativa (Grep/Glob, ripgrep):
// find_in_workspace seria so schema repetido. Em LEITURA o Read nativo sai (read_file_range cobre, com escopo validado e readToken); com ESCOPO,
// nenhuma nativa: so a busca e a leitura do MCP respeitam o escopo. Em EDICAO as nativas ficam (o Edit do Claude exige o Read nativo).
// Claude em LEITURA tambem nao recebe test_evidence: sem Bash ele nao roda teste para registrar, e nenhum lookup devolve reusable=true pelo endpoint do agente (evidence.ts).
// `native` ausente = lista padrao do modo (outros provedores nao aceitam lista por execucao).
export function childToolset(provider: string, mode: 'read' | 'edit', scope: string[], engines: readonly EngineId[] = []): { mcp: ToolDef[]; native?: string[] } {
  const all = toolsFor('child', undefined, engines)
  if (provider !== 'claude') return { mcp: all }
  if (mode === 'edit') return { mcp: all.filter(t => t.name !== FIND_TOOL.name) }
  const read = all.filter(t => t.name !== TEST_EVIDENCE_TOOL.name)
  return scope.length ? { mcp: read, native: [] } : { mcp: read.filter(t => t.name !== FIND_TOOL.name), native: ['Grep', 'Glob'] }
}

// ---- O que a execucao pode ler: itens que ELA MESMA escreveu (mesmo grant) + itens de pacotes que a entrega aceitaria para ela agora
// (aprovados, hash e destinatario conferidos, sessao compativel; snapshot exato do que foi aprovado). Itens de outra sessao/destino da
// mesma linhagem, ou legados sem grant, nao aparecem sem pacote aprovado. Toda rota (indice, item, artefato, delegacao) usa esta funcao.
export type Readable = { key: string; kind: string; title: string; content: string; itemId?: number; revision?: number; source: 'own' | 'package'; packageId?: number; state: string; live?: MemoryRow }
export function readableItems(db: DatabaseSync, g: Grant): Readable[] {
  const taskId = g.taskId
  const own = (db.prepare("SELECT id FROM memory_items WHERE task_id=? AND lineage=? AND grant_id=? AND state<>'superseded' ORDER BY id").all(taskId, g.recipient.logicalId, g.authId) as any[])
    .map((r): Readable => { const m = getMemory(db, taskId, r.id)!; return { key: `m:${m.id}`, kind: m.kind, title: m.title, content: m.content, itemId: m.id, revision: m.revision, source: 'own', state: m.state, live: m } })
  const pk: Readable[] = []
  for (const p of authorizedPackages(db, g).reverse()) {
    for (const i of p.items) {
      const live = i.itemId ? getMemory(db, taskId, i.itemId) ?? undefined : undefined
      pk.push({ key: `p${p.id}:${i.ref}`, kind: i.kind, title: i.title, content: i.content, itemId: i.itemId, revision: i.revision, source: 'package', packageId: p.id, state: live?.state ?? 'snapshot', live })
    }
  }
  return [...own, ...pk]
}

const bad = (m: string): never => { throw new Error(m) }
const optInt = (v: unknown, name: string) => (v == null ? undefined : Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : bad(`${name} invalido.`))
const optStr = (v: unknown, name: string, max = 500) => (v == null || v === '' ? undefined : typeof v === 'string' && v.length <= max ? v : bad(`${name} invalido.`))
const excerptOf = (s: string, n = 160) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const VALIDITY_PT: Record<string, string> = { valid: 'valido', stale: 'DESATUALIZADO', unknown: 'validade desconhecida', superseded: 'substituido' }

function readContext(db: DatabaseSync, lim: ContextLimits, c: ToolCtx, a: any): string {
  const mult = a.expand === true ? 3 : 1
  const chars = lim.queryChars * mult
  const seen: EvidenceReads = new Map()
  const audit = (r: Readable) => {
    if (!r.live) return r.source === 'package' ? 'snapshot aprovado' : ''
    const v = validate(db, r.live, c.cwd, seen)
    return `${VALIDITY_PT[v.validity]}${v.changed.length ? ` (mudou: ${v.changed.slice(0, 3).join(', ')})` : ''}`
  }
  if (a.artifactId !== undefined) {
    const r = readArtifact(db, { taskId: c.taskId, reader: c.auth.authId, id: optInt(a.artifactId, 'artifactId')!, offset: optInt(a.offset, 'offset'), limit: chars })
    if (!r) return 'Artefato nao encontrado ou nao autorizado.'
    return `Artefato #${r.id} (${r.kind}${r.title ? `: ${r.title}` : ''}) · caracteres ${r.offset}-${r.offset + r.content.length} de ${r.size} · hash ${r.hash.slice(0, 12)}${r.next !== null ? ` · proxima pagina: offset ${r.next}` : ' · fim'}\n${r.content}`
  }
  const items = readableItems(db, c.auth)
  if (a.itemId !== undefined) {
    const key = optStr(a.itemId, 'itemId')!
    const r = items.find(i => i.key === key || (/^\d+$/.test(key) && i.key === `m:${key}`))
    if (!r) return 'Item nao encontrado ou nao autorizado.'
    const off = optInt(a.offset, 'offset') ?? 0
    const body = r.content.slice(off, off + chars)
    const end = off + body.length
    return `${r.key} [${r.kind}] ${r.title}${r.revision ? ` · revisao ${r.revision}` : ''} · ${audit(r)}${r.source === 'package' ? ` · pacote aprovado #${r.packageId}` : ''}${end < r.content.length ? ` · proxima pagina: offset ${end}` : ''}\n${body}`
  }
  const kind = optStr(a.kind, 'kind'), want = a.path ? normalize(String(a.path)).replace(/\/$/, '') : '', terms = normalize(String(a.query ?? '')).split(' ').filter(Boolean)
  const matches = items.filter(i => {
    if (kind && i.kind !== kind) return false
    if (terms.length) { const n = normalize(`${i.title} ${i.content}`); if (!terms.every(t => n.includes(t))) return false }
    if (want) { const ps = (i.live?.paths ?? []).map(p => normalize(p).replace(/\/$/, '')); if (!ps.some(x => x === want || x === '.' || want.startsWith(x + '/') || x.startsWith(want + '/'))) return false }
    return true
  })
  const start = optInt(a.cursor === undefined ? undefined : Number(a.cursor), 'cursor') ?? 0
  const limit = Math.min(Math.max(optInt(a.limit, 'limit') ?? lim.queryResults * mult, 1), 50)
  const page: string[] = []
  let used = 0, n = 0
  for (const i of matches.slice(start, start + limit)) {
    const clash = i.source === 'own' && i.live?.conflict_with && items.some(x => x.itemId === i.live!.conflict_with) // so conflito com item que ela propria pode ler
    const line = `${i.key} [${i.kind}] ${i.title} — ${excerptOf(i.content)} · ${audit(i)}${clash ? ` · CONFLITA com #${i.live!.conflict_with}` : ''}`
    if (used + line.length > chars && page.length) break
    page.push(line); used += line.length; n++
  }
  const arts = start === 0 && !kind && !terms.length && !want ? listArtifacts(db, c.taskId, c.auth.authId).slice(0, 10).map(x => `artefato #${x.id} [${x.kind}] ${x.title ?? ''} (${x.size} caracteres)`) : []
  const next = start + n < matches.length ? String(start + n) : null
  return [`${matches.length} item(ns) autorizado(s)${next ? `; mostrando ${start + 1}-${start + n} (proximo cursor: ${next})` : ''}`, ...page, ...(arts.length ? ['Artefatos:', ...arts] : [])].join('\n')
}

function recordMemory(db: DatabaseSync, c: ToolCtx, a: any): string {
  const r = addMemory(db, {
    taskId: c.taskId, owner: c.role === 'child' ? 'delegation' : 'run', originId: c.delegationId ?? c.runId, lineage: c.lineage, grantId: c.auth.authId,
    kind: String(a.kind), title: String(a.title ?? ''), content: String(a.content ?? ''),
    paths: Array.isArray(a.paths) ? a.paths.map(String) : undefined,
    evidence: Array.isArray(a.evidenceFiles) && a.evidenceFiles.length ? { files: fileEvidence(c.cwd, a.evidenceFiles.slice(0, 20).map(String)) } : undefined,
    todoState: optStr(a.todoState, 'todoState'), deps: Array.isArray(a.deps) ? a.deps.map(Number) : undefined, supersedes: optInt(a.supersedes, 'supersedes')
  })
  return `Registrado m:${r.id} (revisao ${r.revision})${r.deduped ? ' — ja existia, nada duplicado' : ''}${r.conflictWith ? ` — CONFLITA com m:${r.conflictWith}: nada foi sobrescrito` : ''}. Privado a esta linhagem ate o usuario aprovar compartilhar.`
}

// find_in_workspace e assincrona (varredura fora do caminho sincrono do processo principal); as demais respondem na hora.
export function callTaskTool(db: DatabaseSync, lim: ContextLimits, c: ToolCtx, name: string, a: any): ToolResult | Promise<ToolResult> {
  try {
    const args = a && typeof a === 'object' && !Array.isArray(a) ? a : {}
    if (c.auth.taskId !== c.taskId) return { text: 'Identidade de execucao nao pertence a esta tarefa.', isError: true } // defesa: nunca cruza tarefas
    const ws = { cwd: c.cwd, allow: c.scope.length ? (f: string) => inScope(f, c.scope) : undefined, session: c.auth.authId }
    switch (name) {
      case READ_CONTEXT_TOOL.name: return { text: readContext(db, lim, c, args), isError: false }
      case RECORD_MEMORY_TOOL.name: return { text: recordMemory(db, c, args), isError: false }
      case READ_SKILL_TOOL_NAME: return { text: loadSkill(c.auth.authId, c.role, args, c.engines), isError: false }
      case FIND_TOOL.name: if (c.role !== 'child') return { text: 'Ferramenta indisponivel neste papel.', isError: true }; return findInWorkspace(ws, args).then(text => ({ text, isError: false }), (e: any) => ({ text: `Erro: ${String(e?.message ?? e).slice(0, 500)}`, isError: true }))
      case READ_RANGE_TOOL.name: if (c.role !== 'child') return { text: 'Ferramenta indisponivel neste papel.', isError: true }; return { text: readFileRange(ws, args, { maxChars: lim.queryChars }), isError: false }
      case TEST_EVIDENCE_TOOL.name: {
        if (c.role !== 'child') return { text: 'Ferramenta indisponivel neste papel.', isError: true }
        const tc = { taskId: c.taskId, lineage: c.lineage, grantId: c.auth.authId, cwd: c.cwd, owner: 'delegation' as const, originId: c.delegationId }
        // A fonte e decidida AQUI, nunca pelo agente: o endpoint que ele chama so pode registrar 'agent_reported' (qualquer campo "source" enviado e ignorado).
        if (args.action === 'record') return { text: JSON.stringify(recordTestEvidence(db, tc, args, 'agent_reported')), isError: false }
        if (args.action === 'lookup') return { text: JSON.stringify(lookupTestEvidence(db, tc, args)), isError: false }
        return { text: 'action deve ser "record" ou "lookup".', isError: true }
      }
      default: return { text: `Ferramenta desconhecida: ${name.slice(0, 60)}`, isError: true }
    }
  } catch (e: any) { return { text: `Erro: ${String(e?.message ?? e).slice(0, 500)}`, isError: true } }
}

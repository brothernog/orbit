// Operacoes locais deterministicas sobre a area de trabalho (buscar, listar, ler por intervalo): baratas, limitadas e com
// contagem total + indicador de truncamento. Caminhos sao validados pelo caminho REAL (links para fora sao recusados) e pelo
// escopo da delegacao. O agente pode ampliar a leitura quando precisar; o limite existe para nao inundar o contexto por acidente.
// Sem dependencia de 'electron' e sem processo externo.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { sha } from './artifacts.ts'
import { safeJoin } from './guard.ts'

const SKIP = new Set(['node_modules', '.git', '.worktrees', 'out', 'dist', 'build', '.godot', '.import', 'tmp', 'temp'])
export type WsCtx = { cwd: string; allow?: (rel: string) => boolean; session?: string } // allow: escopo da delegacao (relativo, com /); session: identidade de execucao (recibos de leitura)
const MAX_FILE = 1_000_000, MAX_SCAN = 5000, LINE_CLIP = 200

// `root` ja resolvido (realpath): a varredura resolve a raiz uma vez, nao por arquivo.
const relFrom = (rootReal: string, abs: string) => path.relative(rootReal, abs).split(path.sep).join('/') || '.'
const rel = (root: string, abs: string) => relFrom(fs.realpathSync(root), abs)
function resolve(ctx: WsCtx, p: string | undefined): { abs: string; rel: string } {
  const p0 = (p ?? '.').trim() || '.'
  if (path.isAbsolute(p0) || /^[a-z]:/i.test(p0) || p0.split(/[\\/]/).includes('..')) throw new Error(`Caminho fora da area de trabalho: "${p0}".`)
  if (p0 === '.' || p0 === './') return { abs: fs.realpathSync(ctx.cwd), rel: '.' } // a propria area (safeJoin exige um caminho DENTRO dela)
  const abs = safeJoin(ctx.cwd, p0)
  return { abs, rel: rel(ctx.cwd, abs) }
}

// Glob minimo: ** = qualquer profundidade, * = dentro de um nivel, ? = um caractere.
export const globToRegex = (g: string) =>
  new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '(?:.*/)?') + '$', 'i')

function* walk(ctx: WsCtx, dirAbs: string, state: { scanned: number; stopped: boolean }, rootReal = fs.realpathSync(ctx.cwd)): Generator<{ abs: string; rel: string }> {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
  for (const e of entries) {
    const abs = path.join(dirAbs, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(ctx, abs, state, rootReal) } // links/junctions nao sao seguidos
    else if (e.isFile()) {
      if (state.scanned >= MAX_SCAN) { state.stopped = true; return }
      state.scanned++
      const r = relFrom(rootReal, abs)
      if (!ctx.allow || ctx.allow(r)) yield { abs, rel: r }
    }
  }
}
// Mesma varredura (ordem, SKIP, MAX_SCAN, escopo), assincrona: a busca do MCP roda no processo principal do app.
async function* walkAsync(ctx: WsCtx, dirAbs: string, state: { scanned: number; stopped: boolean }, rootReal: string): AsyncGenerator<{ abs: string; rel: string }> {
  let entries: fs.Dirent[]
  try { entries = (await fs.promises.readdir(dirAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
  for (const e of entries) {
    if (state.stopped) return
    const abs = path.join(dirAbs, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walkAsync(ctx, abs, state, rootReal) }
    else if (e.isFile()) {
      if (state.scanned >= MAX_SCAN) { state.stopped = true; return }
      state.scanned++
      const r = relFrom(rootReal, abs)
      if (!ctx.allow || ctx.allow(r)) yield { abs, rel: r }
    }
  }
}

// O padrao regex vem do agente: backtracking catastrofico travaria a thread principal. Ele roda num worker que e encerrado
// quando a busca estoura FIND_BUDGET_MS; o resultado parcial sai rotulado. Busca literal (padrao escapado) e linear.
const FIND_BUDGET_MS = 10_000, READ_BATCH = 8
const REGEX_WORKER = `const { parentPort, workerData } = process.getBuiltinModule('node:worker_threads') // vale em CJS e ESM
const re = new RegExp(workerData, 'i')
parentPort.on('message', text => { const hits = [], lines = text.split(/\\r?\\n/); for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i); parentPort.postMessage(hits) })`
type Matcher = { match: (text: string, deadline: number) => Promise<number[] | null>; close: () => void } // null = tempo esgotado
function literalMatcher(re: RegExp): Matcher {
  return { match: async text => text.split(/\r?\n/).flatMap((line, i) => re.test(line) ? [i] : []), close: () => {} }
}
function regexMatcher(pattern: string): Matcher {
  const w = new Worker(REGEX_WORKER, { eval: true, workerData: pattern })
  let failure: Error | undefined, pending: ((e: Error) => void) | undefined
  w.on('error', (e: Error) => { failure = e; pending?.(e) }) // sempre ouvido: erro antes da primeira busca nao derruba o processo
  return {
    match: (text, deadline) => new Promise((ok, fail) => {
      if (failure) return fail(failure)
      const done = (fn: () => void) => { clearTimeout(timer); w.off('message', onHits); pending = undefined; fn() }
      const onHits = (hits: number[]) => done(() => ok(hits))
      const timer = setTimeout(() => done(() => { void w.terminate(); ok(null) }), Math.max(0, deadline - Date.now()))
      pending = e => done(() => fail(e))
      w.on('message', onHits); w.postMessage(text)
    }),
    close: () => { void w.terminate() }
  }
}

export type FindArgs = { mode?: 'search' | 'list'; pattern?: string; regex?: boolean; path?: string; glob?: string; maxResults?: number }
const readText = async (abs: string): Promise<string | null> => {
  try { if ((await fs.promises.stat(abs)).size > MAX_FILE) return null; const b = await fs.promises.readFile(abs); return b.subarray(0, 4096).includes(0) ? null : b.toString('utf8') } catch { return null }
}
export async function findInWorkspace(ctx: WsCtx, a: FindArgs, o: { budgetMs?: number } = {}): Promise<string> {
  const mode = a.mode ?? (a.pattern ? 'search' : 'list')
  const max = Math.min(Math.max(Math.round(a.maxResults ?? 50), 1), 200)
  const base = resolve(ctx, a.path)
  if (!fs.existsSync(base.abs)) throw new Error(`Caminho inexistente: "${base.rel}".`)
  const glob = a.glob ? globToRegex(a.glob) : null
  let re: RegExp | undefined
  if (mode !== 'list') {
    if (!a.pattern || a.pattern.length > 200) throw new Error('pattern obrigatorio (ate 200 caracteres).')
    try { re = a.regex ? new RegExp(a.pattern, 'i') : new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } catch { throw new Error('Expressao regular invalida.') }
  }
  const state = { scanned: 0, stopped: false }, deadline = Date.now() + (o.budgetMs ?? FIND_BUDGET_MS)
  const files = (await fs.promises.stat(base.abs)).isFile() ? (async function* () { if (!ctx.allow || ctx.allow(base.rel)) yield { abs: base.abs, rel: base.rel } })() : walkAsync(ctx, base.abs, state, fs.realpathSync(ctx.cwd))
  const out: string[] = []
  let total = 0, matchedFiles = 0, timedOut = false
  if (mode === 'list') {
    for await (const f of files) {
      if (glob && !glob.test(f.rel)) continue
      total++
      if (out.length < max) out.push(`${f.rel} (${(await fs.promises.stat(f.abs)).size} bytes)`)
    }
  } else {
    const matcher = a.regex ? regexMatcher(a.pattern!) : literalMatcher(re!)
    // Leitura em lotes de READ_BATCH (concorrencia limitada); a contagem segue a ordem da varredura.
    const scan = async (batch: { abs: string; rel: string }[]) => {
      const texts = await Promise.all(batch.map(f => readText(f.abs)))
      for (let k = 0; k < batch.length && !timedOut; k++) {
        const text = texts[k]
        if (text === null) continue
        const hits = await matcher.match(text, deadline)
        if (!hits) { timedOut = true; break }
        const lines = hits.length ? text.split(/\r?\n/) : []
        for (const i of hits) { total++; if (out.length < max) { const line = lines[i]; out.push(`${batch[k].rel}:${i + 1}: ${line.length > LINE_CLIP ? line.slice(0, LINE_CLIP) + '…' : line}`) } }
        if (hits.length) matchedFiles++
      }
    }
    try {
      let batch: { abs: string; rel: string }[] = []
      for await (const f of files) {
        if (glob && !glob.test(f.rel)) continue
        batch.push(f)
        if (batch.length === READ_BATCH) { await scan(batch); batch = [] }
        if (timedOut || Date.now() > deadline) { timedOut = true; break }
      }
      if (!timedOut) await scan(batch)
    } finally { matcher.close() }
  }
  const truncated = total > out.length
  const head = mode === 'list'
    ? `${total} arquivo(s)${truncated ? `; mostrando ${out.length} (TRUNCADO: use path/glob mais estreito ou aumente maxResults)` : ''}`
    : `${total} ocorrencia(s) em ${matchedFiles} arquivo(s)${truncated ? `; mostrando ${out.length} (TRUNCADO: refine pattern/path/glob ou aumente maxResults)` : ''}`
  const warning = timedOut ? `AVISO: busca interrompida no limite de ${Math.round((o.budgetMs ?? FIND_BUDGET_MS) / 1000)} s (expressao regular lenta ou area grande demais); o total pode estar incompleto.`
    : state.stopped ? `AVISO: varredura interrompida apos ${MAX_SCAN} arquivos; o total pode estar incompleto.` : ''
  return [head, warning, ...out].filter(Boolean).join('\n')
}

// ---- Recibos de leitura: prova de que UM intervalo exato de UM arquivo ja foi entregue a ESTA sessao. Ficam so em memoria (limite por sessao,
// descartados ao encerrar/reiniciar). Sem recibo valido a leitura e normal e completa: uma falha do cache so custa uma leitura extra, nunca
// esconde linha ainda nao entregue. O token e opaco e aleatorio; o vinculo (sessao, caminho real, hash completo, intervalo) fica aqui no backend.
// Sessoes guardadas: as mais recentes (recibos de uma sessao continuada sobrevivem ao fim da execucao; ver delegation/index).
const MAX_RECEIPTS_PER_SESSION = 64, MAX_RECEIPT_SESSIONS = 200
type Receipt = { abs: string; hash: string; start: number; end: number }
const receipts = new Map<string, Map<string, Receipt>>()
export const dropReceipts = (session: string) => receipts.delete(session)
export const receiptCount = (session: string) => receipts.get(session)?.size ?? 0
function issueReceipt(session: string, r: Receipt): string {
  let mine = receipts.get(session)
  if (mine) receipts.delete(session) // reinserida no fim: a mais recente
  receipts.set(session, (mine ??= new Map()))
  if (receipts.size > MAX_RECEIPT_SESSIONS) receipts.delete(receipts.keys().next().value as string)
  for (const [tok, x] of mine) if (x.abs === r.abs && x.start === r.start && x.end === r.end) mine.delete(tok) // um recibo por intervalo
  const token = `rt_${crypto.randomBytes(12).toString('hex')}`
  mine.set(token, r)
  if (mine.size > MAX_RECEIPTS_PER_SESSION) mine.delete(mine.keys().next().value as string) // descarta o mais antigo
  return token
}

// `ifHash` (contrato antigo) nao suprime mais nada: o hash do arquivo sozinho nao prova que ESTE intervalo foi entregue.
export type ReadArgs = { path: string; startLine?: number; endLine?: number; readToken?: string; ifHash?: string }
export const MAX_LINES = 400, LONG_LINE = 2000
// maxChars: orcamento de conteudo nas consultas MCP e nos trechos anexados. Corte so em linhas inteiras, rotulado e SEM recibo.
export function readFileRange(ctx: WsCtx, a: ReadArgs, o: { maxChars?: number } = {}): string {
  const f = resolve(ctx, a.path)
  if (ctx.allow && !ctx.allow(f.rel)) throw new Error(`"${f.rel}" esta fora do escopo desta delegacao.`)
  if (!fs.existsSync(f.abs) || !fs.statSync(f.abs).isFile()) throw new Error(`Arquivo inexistente: "${f.rel}".`)
  const buf = fs.readFileSync(f.abs)
  if (buf.subarray(0, 4096).includes(0)) throw new Error(`"${f.rel}" parece binario.`)
  const hash = sha(buf)
  const lines = buf.toString('utf8').split(/\r?\n/)
  const start = Math.max(1, Math.round(a.startLine ?? 1))
  const end = Math.min(lines.length, Math.round(a.endLine ?? start + 199), start + MAX_LINES - 1)
  const head = `${f.rel} (linhas ${start}-${end} de ${lines.length}; hash ${hash.slice(0, 12)}`
  // O recibo apresentado prova que ESTA sessao recebeu o intervalo dele, inteiro, deste arquivo com este conteudo (hash completo). Com ele:
  // intervalo pedido DENTRO do recibo = nada reenviado; sobreposto numa ponta = so as linhas que faltam. Sem recibo valido (ou recibo no meio
  // do pedido) a leitura e completa: o backend nunca supoe o que o modelo ainda tem.
  const prior = ctx.session && typeof a.readToken === 'string' ? receipts.get(ctx.session)?.get(a.readToken) : undefined
  const valid = prior && prior.abs === f.abs && prior.hash === hash ? prior : undefined
  if (valid && valid.start <= start && valid.end >= end)
    return valid.start === start && valid.end === end
      ? `${head}): este mesmo intervalo ja foi entregue nesta sessao e o arquivo nao mudou (readToken valido); nenhum conteudo reenviado.`
      : `${head}): contido no intervalo ${valid.start}-${valid.end} ja entregue nesta sessao, e o arquivo nao mudou (readToken valido); nenhum conteudo reenviado.`
  let from = start, to = end
  if (valid && valid.start <= start && valid.end >= start) from = valid.end + 1 // ja tem o comeco
  else if (valid && valid.start <= end && valid.end >= end) to = valid.start - 1 // ja tem o fim
  const partial = from !== start || to !== end
  let slice = lines.slice(from - 1, to)
  let body = slice.map((l, i) => `${from + i}\t${l.length > LONG_LINE ? l.slice(0, LONG_LINE) + '…' : l}`)
  let budgetCut = false
  if (o.maxChars !== undefined) {
    let used = 0, n = 0
    while (n < body.length && used + body[n].length + 1 <= o.maxChars) used += body[n++].length + 1
    if (n < body.length) { budgetCut = true; slice = slice.slice(0, n); body = body.slice(0, n) }
  }
  const truncated = budgetCut || end < Math.min(lines.length, Math.round(a.endLine ?? Infinity))
  const clipped = slice.some(l => l.length > LONG_LINE)
  // Recibo so para entrega COMPLETA: linha cortada ou intervalo truncado nao geram token (a repeticao devolve o trecho de novo).
  // Entrega parcial completa + recibo anterior = a sessao tem a UNIAO (contigua): o novo recibo cobre as duas.
  const [rs, re] = partial ? [Math.min(start, valid!.start), Math.max(end, valid!.end)] : [start, end]
  const token = ctx.session && slice.length && !truncated && !clipped ? issueReceipt(ctx.session, { abs: f.abs, hash, start: rs, end: re }) : ''
  const skipped = partial ? `; linhas ${from > start ? `${start}-${from - 1}` : `${to + 1}-${end}`} ja entregues nesta sessao com o arquivo inalterado (readToken); exibindo ${from}-${to}` : ''
  return [`${head}${skipped}${end < lines.length ? '; ha mais linhas: peca outro intervalo' : ''}${budgetCut ? `; CORTADO no limite de tamanho: ${slice.length ? `exibindo ${from}-${from + slice.length - 1}` : 'nenhuma linha coube'}, leia o resto se precisar` : truncated ? `; TRUNCADO em ${MAX_LINES} linhas por chamada` : ''}${clipped ? `; linhas acima de ${LONG_LINE} caracteres foram cortadas` : ''}${token ? `; readToken ${token}${partial ? ` (vale para ${rs}-${re})` : ''}` : ''})`, ...body].join('\n')
}

// Arquivos sob um caminho (arquivo -> ele mesmo; pasta -> todos os arquivos dentro). Mais que `max`: erro, nunca corte silencioso
// (uma lista de dependencias truncada faria uma evidencia parecer valida sem cobrir tudo).
export function listFilesUnder(ctx: WsCtx, p: string, max = 200): string[] {
  const base = resolve(ctx, p)
  if (!fs.existsSync(base.abs)) throw new Error(`Caminho inexistente: "${base.rel}".`)
  if (fs.statSync(base.abs).isFile()) return [base.rel]
  const out: string[] = []
  const state = { scanned: 0, stopped: false }
  for (const f of walk({ cwd: ctx.cwd }, base.abs, state)) {
    if (out.length >= max) throw new Error(`Mais de ${max} arquivos sob "${base.rel}": declare dependencias mais estreitas.`)
    out.push(f.rel)
  }
  if (state.stopped) throw new Error(`Pasta grande demais para declarar como dependencia: "${base.rel}".`)
  return out
}

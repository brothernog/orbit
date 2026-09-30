// Executa uma mensagem de chat numa CLI headless: streaming, erros, cancelamento da arvore de processos.
// Sem dependencia de 'electron' (testavel com CLIs simuladas).
import path from 'node:path'
import type { Ev, Metric } from './adapters.ts'
import { categorize, cliSpawn, killTree, resolveCli, sanitize, type Category } from './providers.ts'

// Junta medidas: contexto/janela = o mais recente; consumo = o mais recente ou, com `accumulate`, a soma dos passos.
export function mergeMetric(prev: Metric | undefined, n: Metric, accumulate = false): Metric {
  if (!prev) return { ...n }
  const sum = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : accumulate ? a + b : b)
  return {
    occupied: n.occupied ?? prev.occupied, capacity: n.capacity ?? prev.capacity,
    estimated: n.occupied !== undefined ? n.estimated : prev.estimated,
    consumedIn: sum(prev.consumedIn, n.consumedIn), consumedOut: sum(prev.consumedOut, n.consumedOut),
    cacheRead: sum(prev.cacheRead, n.cacheRead), cacheWrite: sum(prev.cacheWrite, n.cacheWrite), reasoning: sum(prev.reasoning, n.reasoning),
    reasoningIncluded: n.reasoningIncluded ?? prev.reasoningIncluded, cacheReadIncluded: n.cacheReadIncluded ?? prev.cacheReadIncluded,
    scope: n.scope ?? prev.scope, source: n.source
  }
}

export type ChatResult = {
  status: 'completed' | 'failed' | 'cancelled'
  text: string // resposta como aparece no chat: texto + marcadores de ferramenta (parcial se falhou/cancelou)
  notes: string[]
  // Separacao entre resposta e atividade (o `text` acima continua sendo a visao de chat).
  messages?: string[] // mensagens do agente em ordem, sem marcadores de ferramenta
  tools?: string[] // ferramentas/comandos executados, em ordem (so os nomes/comandos que a CLI informou)
  answer?: string // resposta final extraida; vazia = nao ha texto
  answerBasis?: 'explicit' | 'limited' // explicit = a CLI marcou a conclusao; limited = ultima mensagem (a CLI nao distingue comentario de resposta final)
  retries?: number // erros transitorios (ex.: "Reconnecting 1/5") vistos durante a execucao
  durationMs?: number
  session?: string
  usage?: any
  metric?: Metric
  paused?: boolean // parado pelo teto de ferramentas (maxTools); status 'cancelled', sessao preservada para continuar
  error?: string // ja sanitizado
  category?: Category
  code: number | null
}

export type RunOptions = {
  cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv
  input: string // mensagem do usuario: vai pelo stdin, nunca na linha de comando
  parse: (ev: any) => Ev[]
  onSession?: (id: string) => void
  onText?: (fullText: string) => void
  onUsage?: (data: any) => void
  onMetric?: (m: Metric) => void // medida acumulada a cada evento de contexto (medidor ao vivo)
  onTool?: (name: string, detail?: string, ref?: string) => void // cada ferramenta que comeca (o que o agente faz agora); ref liga ao resultado
  onToolResult?: (ref: string, ok: boolean | null, output: string) => void // resultado informado pela CLI (so Claude e Codex informam)
  maxTools?: number // teto de ferramentas por mensagem: ao pedir a seguinte, a execucao pausa (0/ausente = sem teto)
}

const tail = (s: string, n = 2000) => s.slice(-n)
const GENERIC_ERROR = /unexpected server error|check server logs/i
const CAUSE = /\b([A-Z]\w*Error): ([^"\\\n)]{3,300})/ // ex.: ProviderModelNotFoundError: Model not found: x/y. Did you mean: ...

export function runChat(o: RunOptions): { cancel: (sync?: boolean) => void; result: Promise<ChatResult> } {
  let cancelled = false
  let cancelHook = (_sync = false) => {}
  const cancel = (sync = false) => { cancelled = true; cancelHook(sync) }

  const result = (async (): Promise<ChatResult> => {
    let text = '', session: string | undefined, usage: any, metric: Metric | undefined, done = false
    let fatal: string | undefined, soft: string | undefined
    let stderr = '', stderrHead = '', spawnError: string | undefined // stderrHead: o COMECO do stderr (a causa costuma vir antes da pilha)
    let doneText: string | undefined
    let rawOut = '' // linhas nao-JSON do stdout (avisos, erros em texto)
    const notes: string[] = []
    const messages: string[] = [], tools: string[] = []
    let lastWasText = false, retries = 0, paused = false, limited = false
    const seenKeys = new Set<string>() // passos de consumo ja contados (evento repetido nao soma duas vezes)
    const t0 = Date.now()
    const finish = (code: number | null): ChatResult => {
      if (!text && done && doneText) { text = doneText; messages.push(doneText) }
      const answer = doneText?.trim() || messages[messages.length - 1]?.trim() || ''
      const base = { text: text.trim(), notes, session, usage, metric, code, messages, tools, answer, answerBasis: (doneText?.trim() ? 'explicit' : 'limited') as 'explicit' | 'limited', retries, durationMs: Date.now() - t0 }
      if (cancelled) return { ...base, status: 'cancelled', ...(paused ? { paused } : {}) }
      // Erro generico do proprio provedor ("Unexpected server error"): a causa real, quando a CLI a escreve no stderr, e mais util que ele.
      const cause = fatal && GENERIC_ERROR.test(fatal) ? CAUSE.exec(stderrHead) : null
      const detail = (cause ? `${cause[1]}: ${cause[2].trim()}` : fatal) ?? spawnError ?? (code ? soft || tail(stderr).trim() || tail(rawOut).trim() || `A CLI terminou com codigo ${code}.` : undefined)
      if (detail) return { ...base, status: 'failed', error: sanitize(detail), category: limited ? 'limit' : categorize(detail), code }
      // Codigo 0 sem conclusao explicita nem resposta: nao e sucesso (protocolo inesperado ou erro so no stderr).
      if (!done && !text) {
        const e = tail(stderr).trim() || 'A CLI terminou sem produzir resposta (saida em formato inesperado).'
        return { ...base, status: 'failed', error: sanitize(e), category: limited ? 'limit' : tail(stderr).trim() ? categorize(e) : 'protocol', code }
      }
      return { ...base, status: 'completed' }
    }
    const exe = path.isAbsolute(o.cmd) ? o.cmd : await resolveCli(o.cmd)
    if (cancelled) return finish(null)
    if (!exe) return { status: 'failed', text: '', notes, code: null, category: 'command', error: `${o.cmd} nao encontrado no PATH.` }
    const child = cliSpawn(exe, o.args, { cwd: o.cwd, env: o.env })

    const handle = (line: string) => {
      if (!line.trim()) return
      let ev: any
      try { ev = JSON.parse(line) } catch { rawOut = tail(rawOut + line + '\n'); return }
      for (const e of o.parse(ev)) {
        if (e.kind === 'session') { if (e.id !== session) { session = e.id; o.onSession?.(e.id) } }
        else if (e.kind === 'text') {
          text += (text && !e.delta && !text.endsWith('\n') ? '\n\n' : '') + e.text; o.onText?.(text)
          if (e.delta && lastWasText) messages[messages.length - 1] += e.text; else messages.push(e.text)
          lastWasText = true
        }
        else if (e.kind === 'tool' && o.maxTools && tools.length >= o.maxTools) {
          // Para ANTES da ferramenta seguinte rodar (o evento chega antes da execucao): nada fica pela metade e a sessao continua valida.
          if (!paused) { paused = true; notes.push(`Pausado apos ${o.maxTools} ferramentas nesta mensagem, para nao gastar sem limite. A sessao foi mantida: responda "continuar" para seguir.`); cancel() }
          return
        }
        else if (e.kind === 'toolResult') o.onToolResult?.(e.ref, e.ok, e.output ?? '')
        else if (e.kind === 'tool') { o.onTool?.(e.name, e.detail, e.ref); text += `\n\n\`> ${e.name.replace(/`/g, "'").slice(0, 200)}\`\n\n`; o.onText?.(text); tools.push(e.name.slice(0, 500)); lastWasText = false }
        else if (e.kind === 'usage') { usage = e.data; o.onUsage?.(e.data) }
        else if (e.kind === 'context') {
          if (e.key && e.accumulate) { if (seenKeys.has(e.key)) continue; seenKeys.add(e.key) }
          metric = mergeMetric(metric, e.metric, e.accumulate); o.onMetric?.(metric)
        }
        else if (e.kind === 'note') notes.push(e.text)
        else if (e.kind === 'limit') limited = true
        else if (e.kind === 'error') { if (e.fatal) fatal = e.message; else { soft = e.message; retries++ } }
        else if (e.kind === 'done') { done = true; doneText = e.text }
      }
    }

    return new Promise<ChatResult>(resolve => {
      let settled = false
      const settle = (r: ChatResult) => { if (!settled) { settled = true; resolve(r) } }
      let buf = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', d => {
        buf += d
        const lines = buf.split('\n')
        buf = lines.pop()!
        lines.forEach(handle)
      })
      child.stderr.on('data', d => { stderr = tail(stderr + d); if (stderrHead.length < 20_000) stderrHead += d })
      child.stdin.on('error', () => {}) // EPIPE: a CLI saiu antes de ler tudo; o motivo vem do codigo/stderr
      child.stdin.end(o.input)
      child.on('error', e => {
        spawnError = e.message
        if (child.pid === undefined) setTimeout(() => settle(finish(null)), 100) // nao chegou a iniciar
      })
      child.on('close', code => {
        if (buf) handle(buf) // ultimo evento sem newline
        buf = ''
        settle(finish(code))
      })
      cancelHook = (sync = false) => {
        killTree(child, sync)
        setTimeout(() => settle(finish(null)), 5000).unref() // nao prende a UI se o processo nao morrer
      }
      if (cancelled) cancelHook()
    })
  })()
  return { cancel, result }
}

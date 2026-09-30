// Avisos de atencao: terminou, etapa para revisar, falhou, pausou, pede aprovacao. Monta o RESUMO a partir do que o app observou
// (arquivos alterados nesta execucao, comandos e testes que rodaram, tempo) e do que o agente declarou (conclusao), sempre rotulados
// separados. Quem mostra (janela de aviso no canto da tela ou cartao no app) e index.ts/renderer. Sem Electron. O aviso so abre a
// tarefa, nunca executa nada.
import { extractConclusion } from './envelope.ts'
import { summarizeTestOutput } from './evidence.ts'

export type NotifyPrefs = { done: boolean; failed: boolean; approval: boolean; system: boolean; sound: boolean }
export const DEFAULT_NOTIFY: NotifyPrefs = { done: true, failed: true, approval: true, system: true, sound: true }
export const normalizeNotify = (raw: any): NotifyPrefs =>
  Object.fromEntries(Object.entries(DEFAULT_NOTIFY).map(([k, d]) => [k, typeof raw?.[k] === 'boolean' ? raw[k] : d])) as NotifyPrefs

export type NoticeKind = 'done' | 'review' | 'failed' | 'paused' | 'permission' | 'question' | 'context' | 'cmd-ok' | 'cmd-fail'
export type FileDelta = { path: string; added: number | null; removed: number | null; isNew: boolean }
export type Notice = {
  key: number // atribuido por index.ts
  kind: NoticeKind; taskId: number; game: string
  heading: string // "Terminou", "Falhou"...
  title: string // titulo da tarefa
  project: string; provider: string | null; model: string | null
  duration: string | null
  summary: string // o que o agente declarou (done/review) ou o texto do pedido/erro
  summaryFrom: 'agent' | 'app'
  step: string | null // etapa do workflow pronta para revisao
  files: FileDelta[] | null // null = sem Git para comparar; [] = nada mudou nesta execucao
  filesTotal: { count: number; added: number; removed: number } | null
  activity: Activity | null
  command: { name: string; exitCode: number | null } | null // comando do projeto (Teste/Build/Jogo) que terminou
  ref?: { permission?: number; question?: number; context?: number } // o cartao some quando o pedido e resolvido
}
// O que index.ts busca no banco/disco para o evento.
export type NoticeInfo = {
  task: { title: string; game: string; project: string } | null
  step?: string | null
  changes?: FileDelta[] | null
  permission?: { provider: string; summary: string } | null
  question?: { provider: string; summary: string } | null
  context?: { items: number; recipient: string } | null
}

const LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' }
export const providerLabel = (p: string) => LABEL[p] ?? p

export function duration(ms: unknown): string | null {
  if (typeof ms !== 'number' || !(ms >= 0)) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

const plain = (p: string) => p.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim()
const cut = (p: string, max: number) => {
  if (p.length <= max) return p
  const c = p.slice(0, max - 1), sp = c.lastIndexOf(' ')
  return `${c.slice(0, sp > max * 0.6 ? sp : c.length).replace(/[\s,.;:]+$/, '')}…`
}
const paragraphs = (text: unknown) => String(text ?? '').replace(/```[\s\S]*?(```|$)/g, ' ').split(/\n\s*\n/).map(plain).filter(Boolean)

// Ultimo paragrafo (erros, pedidos), sem markdown, cortado numa palavra.
export const snippet = (text: unknown, max = 160) => cut(paragraphs(text).at(-1) ?? '', max)

// Resumo que o agente declarou: campo "Resultado" do bloco [CONCLUSAO] quando existe; senao o primeiro paragrafo da resposta final
// (onde os agentes costumam dizer o que fizeram), sem cabecalho solto nem frase de cortesia.
export function agentSummary(answer: unknown, max = 240): string {
  const a = String(answer ?? '')
  const c = extractConclusion(a)
  if (c.kind === 'block') {
    const r = c.text.split('\n').map(l => l.trim()).find(l => /^resultado\s*:/i.test(l))
    if (r) return cut(plain(r.replace(/^resultado\s*:\s*/i, '')), max)
  }
  const ps = paragraphs(a.replace(/^\s*#{1,6} .*$/gm, '')).filter(p => !/^(pronto|feito|ok|certo|claro)[.!]?$/i.test(p))
  return cut(ps[0] ?? '', max)
}

// Arquivos que mudaram NESTA execucao: diferenca entre o estado do Git no inicio e no fim (o que ja estava sujo antes nao conta).
type Stat = { path: string; status: string; added: number | null; removed: number | null }
export function runChanges(before: Stat[], after: Stat[]): FileDelta[] {
  const prev = new Map(before.map(f => [f.path, f]))
  const sub = (a: number | null, b: number | null | undefined) => (a == null ? null : Math.max(0, a - (b ?? 0)))
  return after.flatMap(f => {
    const p = prev.get(f.path)
    if (p && p.added === f.added && p.removed === f.removed && p.status === f.status) return []
    const same = p && p.status === f.status
    return [{ path: f.path, added: same ? sub(f.added, p!.added) : f.added, removed: same ? sub(f.removed, p!.removed) : f.removed, isNew: f.status === '?' || f.status === 'A' }]
  }).sort((a, b) => ((b.added ?? 0) + (b.removed ?? 0)) - ((a.added ?? 0) + (a.removed ?? 0)))
}

// Comandos e testes que rodaram. O resultado de cada teste so conta quando a CLI o informou (Claude: is_error; Codex: exit code) e o
// resumo ("12 testes, 12 passaram") so sai de formatos conhecidos da saida (evidence.ts). Sem informacao, o teste fica "sem resultado".
// Codex informa so comandos, com o proprio comando no nome.
export type Act = { line: string; ref?: string; ok?: boolean | null; summary?: string }
export type Activity = { tools: number; commands: number; tests: number; passed: number; failed: number; lastOk: boolean | null; summary: string | null }
const SHELL = /^(bash|shell|run_shell_command|command|exec|execute)\b/i
const TEST = /(\btest\b|\btests\b|--test\b|pytest|vitest|jest|mocha|\bgut\b|gdunit|cargo test|go test|dotnet test|npm (run )?test|typecheck)/i
export const isTestCommand = (line: string) => TEST.test(line)
export function activityOf(acts: unknown, provider: string | null): Activity | null {
  if (!Array.isArray(acts)) return null
  const list: Act[] = acts.flatMap(a => (typeof a === 'string' ? [{ line: a }] : a && typeof a.line === 'string' ? [a as Act] : []))
  const cmds = list.filter(a => provider === 'codex' || SHELL.test(a.line))
  const tests = cmds.filter(a => TEST.test(a.line))
  // O ultimo teste com resultado e o que vale para o resumo (o agente costuma rodar de novo depois de corrigir).
  const last = [...tests].reverse().find(a => typeof a.ok === 'boolean')
  return {
    tools: list.length, commands: cmds.length, tests: tests.length, passed: tests.filter(a => a.ok === true).length, failed: tests.filter(a => a.ok === false).length,
    lastOk: last ? last.ok! : null, summary: last ? (last.summary ?? (last.ok ? 'Último teste passou' : 'Último teste falhou')) : null
  }
}

const totals = (files: FileDelta[] | null) => files && {
  count: files.length, added: files.reduce((n, f) => n + (f.added ?? 0), 0), removed: files.reduce((n, f) => n + (f.removed ?? 0), 0)
}

// Evento do chat -> aviso (ou null). Cancelado pelo usuario nao avisa; preferencia desligada nao avisa.
export function noticeFor(ev: any, info: NoticeInfo, prefs: NotifyPrefs): Omit<Notice, 'key'> | null {
  const t = info.task
  if (!t || typeof ev?.taskId !== 'number') return null
  const empty = { taskId: ev.taskId, game: t.game, title: t.title, project: t.project, step: null, files: null, filesTotal: null, activity: null, command: null, duration: null, model: null }
  if (ev.commandDone) return commandNotice(ev.commandDone, empty, prefs)
  if (ev.done) {
    const p = typeof ev.provider === 'string' ? ev.provider : null
    const files = info.changes === undefined ? null : info.changes
    const run = { ...empty, provider: p, model: typeof ev.model === 'string' ? ev.model : null, duration: duration(ev.durationMs),
      files: files && files.slice(0, 4), filesTotal: totals(files), activity: activityOf(ev.acts, p) }
    if (ev.status === 'completed') {
      if (!prefs.done) return null
      const summary = agentSummary(ev.answer)
      return { ...run, kind: info.step ? 'review' : 'done', heading: info.step ? 'Etapa pronta para revisão' : 'Terminou', step: info.step ?? null,
        summary: summary || 'O agente terminou sem texto de resposta.', summaryFrom: summary ? 'agent' : 'app' }
    }
    if (!prefs.failed) return null
    if (ev.status === 'failed') return { ...run, kind: 'failed', heading: 'Falhou', summary: snippet(ev.error, 220) || 'A execução terminou com erro. Abra a tarefa para ver o detalhe.', summaryFrom: 'app' }
    if (ev.status === 'cancelled' && ev.paused) return { ...run, kind: 'paused', heading: 'Pausou no teto de ferramentas', summary: 'A sessão foi preservada: abra a tarefa e continue quando quiser.', summaryFrom: 'app' }
    return null
  }
  if (!prefs.approval) return null
  if (ev.permissionRequest && info.permission) {
    return { ...empty, kind: 'permission', heading: 'Pede permissão', provider: info.permission.provider, summary: cut(plain(info.permission.summary), 200), summaryFrom: 'app', ref: { permission: ev.permissionRequest } }
  }
  if (ev.questionRequest && info.question) { // o agente esta parado esperando: mesmo peso de um pedido de permissao
    return { ...empty, kind: 'question', heading: 'Tem uma pergunta', provider: info.question.provider, summary: cut(plain(info.question.summary), 200), summaryFrom: 'agent', ref: { question: ev.questionRequest } }
  }
  if (ev.contextRequest && info.context) {
    const c = info.context
    return { ...empty, kind: 'context', heading: 'Pede aprovação de contexto', provider: null,
      summary: `${c.items} ${c.items === 1 ? 'item' : 'itens'} para ${c.recipient}. Nada foi enviado ainda.`, summaryFrom: 'app', ref: { context: ev.contextRequest } }
  }
  return null
}

// Comando do projeto que terminou: a Orbita executou e viu o exit code e a saida. Jogo fechado sem erro nao avisa (foi voce que fechou).
const lastLines = (out: string) => out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-2).join(' · ')
function commandNotice(c: any, base: any, prefs: NotifyPrefs): Omit<Notice, 'key'> | null {
  if (!c || typeof c.name !== 'string' || !['completed', 'failed'].includes(c.status)) return null
  const ok = c.status === 'completed'
  if (ok ? !prefs.done || c.purpose === 'run' : !prefs.failed) return null
  const out = String(c.output ?? '')
  const parsed = summarizeTestOutput(out)?.summary
  const heading = c.purpose === 'test' ? (ok ? 'Teste passou' : 'Teste falhou') : c.purpose === 'build' ? (ok ? 'Build concluído' : 'Build falhou') : 'O jogo fechou com erro'
  const summary = parsed ?? (ok ? 'Terminou sem erro.' : cut(String(c.error || lastLines(out) || 'Terminou com erro.'), 220))
  return { ...base, kind: ok ? 'cmd-ok' : 'cmd-fail', heading, provider: null, duration: duration(c.durationMs), summary, summaryFrom: 'app',
    command: { name: c.name, exitCode: typeof c.exitCode === 'number' ? c.exitCode : null } }
}

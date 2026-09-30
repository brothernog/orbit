// Assistente da home. Mesma entrada e execução; sem importar Electron.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fail, scopeTo } from './guard.ts'
import { AGENTS } from './adapters.ts'
import { projectInfo } from './projectInfo.ts'
import { runChat } from './runner.ts'
import { buildPrompt, DEFAULT_JARVIS, JARVIS_INSTRUCTIONS, JARVIS_SYSTEM_FILE, jarvisArgs, parseReply, retryCompat, sanitizeInput, type JarvisSettings, type Snapshot } from './jarvis.ts'
import type { TaskSel as Sel } from './tasks.ts'
import type { LogEntry } from './providers.ts'
type JarvisDeps = {
  db: DatabaseSync; getSetting: (key: string) => string | undefined; accountRow: (id?: number | null) => { id: number; name: string } | null
  checkSel: (sel: Sel) => Promise<void>; listGames: () => string[]; projectNames: () => Record<string, string>
  listActive: () => { provider: string; game: string; title: string; startedAt: number }[]
  envFor: (sel: Sel) => NodeJS.ProcessEnv; emit: (ev: object) => void; dataDir: string
  logFor: (provider: string, profile?: string) => (e: Partial<LogEntry>) => void
}
export function createJarvisService(d: JarvisDeps) {
  const { db, getSetting, accountRow, checkSel, listGames, projectNames, listActive, envFor, emit, dataDir, logFor } = d
  const jarvisSettings = (): JarvisSettings => {
    const v = { ...DEFAULT_JARVIS, ...JSON.parse(getSetting('jarvis') ?? '{}') }
    return { ...v, accountId: accountRow(v.accountId)?.id ?? (db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get() as any)?.id }
  }
  let jarvisRun: { cancel: (sync?: boolean) => void } | null = null
  let jarvisLean = true // Jarvis sem ferramentas, sem MCP global e com prompt de sistema proprio; desliga ate reiniciar se a CLI recusar
  // `project`: Nova aberta numa pasta; a foto enviada ao modelo so tem essa pasta e os agentes dela.
  async function askJarvis(question: string, rawTodo: unknown, rawHistory: unknown, project?: string) {
    if (jarvisRun) fail('O Jarvis ainda está respondendo.')
    const { todo, history } = sanitizeInput(rawTodo, rawHistory)
    const j = jarvisSettings()
    const sel = { provider: 'claude', accountId: j.accountId, model: j.model, effort: j.effort }
    await checkSel(sel)
    const games = scopeTo(listGames(), project)
    const names = projectNames()
    const nameOf = (g: string) => names[g] ?? path.basename(g)
    const recent = db.prepare("SELECT title FROM tasks WHERE game=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 3")
    const act = db.prepare("SELECT MAX(updated_at) last, SUM(state<>'concluida' AND archived_at IS NULL) open FROM tasks WHERE game=?")
    const projects = await Promise.all(games.map(async g => {
      const i = await projectInfo(g, () => null).catch(() => null)
      const a = act.get(g) as any
      return {
        name: nameOf(g), kind: i?.kind ?? 'app', stack: i?.stack ?? 'Projeto', branch: i?.git?.branch ?? null,
        uncommitted: (i?.git?.files.length ?? 0) + (i?.worktrees.reduce((n, w) => n + w.files.length, 0) ?? 0), worktrees: i?.worktrees.length ?? 0,
        openTasks: a?.open ?? 0, lastActivity: a?.last ?? null, recent: (recent.all(g) as any[]).map(r => String(r.title).slice(0, 80)),
      }
    }))
    const agents = (listActive() as any[]).filter(a => scopeTo(games, a.game, true).length).map(a => ({ provider: a.provider, project: nameOf(a.game), task: String(a.title).slice(0, 80), minutes: Math.round((Date.now() - a.startedAt) / 60000) }))
    const snap: Snapshot = { now: new Date().toLocaleString('pt-BR'), projects, agents, todo }
    const cwd = path.join(dataDir, 'jarvis')
    fs.mkdirSync(cwd, { recursive: true })
    const start = (lean: boolean) => {
      if (lean) fs.writeFileSync(path.join(cwd, JARVIS_SYSTEM_FILE), JARVIS_INSTRUCTIONS) // sempre o texto desta versao do app
      return runChat({
        cmd: AGENTS.claude.cmd, args: jarvisArgs({ model: j.model, effort: j.effort, lean }), cwd, env: envFor(sel), parse: AGENTS.claude.parse,
        input: buildPrompt(snap, history, question, { lean }),
        onText: full => emit({ jarvis: true, text: parseReply(full, projects.map(p => p.name)).text }),
      })
    }
    let lean = jarvisLean
    let run = start(lean)
    jarvisRun = { cancel: sync => run.cancel(sync) }
    try {
      let r = await run.result
      if (retryCompat(lean, r)) { // enxuto recusado: repete no compativel e nao tenta mais o enxuto ate reiniciar o app
        logFor('claude', accountRow(j.accountId)?.name)({ cwd, args: ['jarvis', 'enxuto'], code: r.code, category: r.category, detail: `modo enxuto recusado; repetindo no compativel: ${r.error ?? ''}` })
        jarvisLean = lean = false
        run = start(false)
        r = await run.result
      }
      if (r.status === 'cancelled') return { status: 'cancelled', text: '', actions: [] }
      if (r.status === 'failed') {
        logFor('claude', accountRow(j.accountId)?.name)({ cwd, args: ['jarvis'], code: r.code, category: r.category, detail: r.error })
        return { status: 'failed', error: r.error ?? 'O Jarvis não respondeu.', text: '', actions: [] }
      }
      return { status: 'ok', ...parseReply(r.answer || r.text, projects.map(p => p.name)) }
    } finally { jarvisRun = null }
  }


  return { askJarvis, jarvisSettings, stopJarvis: () => jarvisRun?.cancel() }
}

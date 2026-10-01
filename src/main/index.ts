import { createCommandService, listCommandRuns, projectCommands, reconcileCommands, saveCommands } from './commands.ts'
import { createCheckpoint as takeCheckpoint, listCheckpoints, previewRewind, rewindCheckpoint } from './checkpoints.ts'
import { taskAgents, type Doing } from './agentsLive.ts'
import { addStep, activeStep, beginStep, bindStep, failStep, listSteps, reconcileSteps, reviewStep } from './workflows.ts'
import { todoBoard, saveTodo, todoTask } from './planning.ts'
import { createChatService } from './chatService.ts'
import { createAutomations } from './automations.ts'
import { createHandover, normalizeHandover } from './handover.ts'
import { returnReads } from './settingsReads.ts'
import { createDoc, editDoc } from './docs.ts'
import { createAccountUsageService } from './accountUsage.ts'
import { createJarvisService } from './jarvisService.ts'
import { createLinkedInService } from './linkedinService.ts'
import { createProductionIpc } from './productionIpc.ts'
import { applyPendingRestore, createBackup, inspectBackup, stageRestore } from './backups.ts'
import { backupGate } from './backupGate.ts'
import { createWorktreeService } from './worktrees.ts'
import { resetWorkspace, unlinkWorktree } from './worktreeTasks.ts'
import { engineHandlers } from './engineIpc.ts'
import { callEngineTool, engineOf, grantedEngines, grantedTools, liveGrants } from './engineMcp.ts'
import { engineGrants, type EngineGrants } from './engines.ts'
import { engineCommandError, validatePreparedEngine } from './engineFlow.ts'
import { setBlenderScriptRoots } from './blender.ts'
import { validatePreparedGodot, godotCommandError } from './godotFlow.ts'
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { AGENTS, SAFE_ARG, type Metric } from './adapters.ts'
import { getCatalog, peekCatalog, validateSelection } from './catalog.ts'
import { codexContextFromRollout, codexLimits, findRollout } from './codexSession.ts'
import { projectIconData } from './projectIcon.ts'
import { changedFiles, dirtOf, fileDiff, recentCommits, stopWatching, watchDir } from './fileWatch.ts'
import { createPulse } from './pulse.ts'
import { createNoticeInfo } from './noticeInfo.ts'
import { createAccounts } from './accounts.ts'
import { branchHandlers } from './branchIpc.ts'
import { checkpointDb, openDb } from './db.ts'
import { asAllowedPath, asInt, asStr, cleanGroups, fail, inside, pickGames, safeJoin, samePath } from './guard.ts'
import { cancelLogin, claudeStatus, hostlessEnv, logEvent, loginShellPath, loginState, mergePath, openTerminal, probeProvider, providerAuth, startLogin, type LogEntry } from './providers.ts'
import { parseAliases, validateAliases } from './agents.ts'
import { delegateTool, DEFAULT_SETTINGS, mcpWire, normalizeSettings, reconcileDelegations, runDelegation, TOOL_NAME, WorkspaceGuard, type Deps, type McpWire, type ParentCtx } from './delegation.ts'
import { ApprovalWaiters, type Decision } from './consent.ts'
import { awaitingSend, reconcileSends, reconcileStarting } from './sends.ts'
import { effectiveLimits, normalizeLimits } from './limits.ts'
import { inUse, moons, planetLayout, planetUsage } from './planet.ts'
import { copyIntoWorktree, copyList, copyNote, copySuggestions, saveCopyList } from './worktreeSetup.ts'
import { normalizeNotify, noticeFor, type Notice, type NotifyPrefs } from './notify.ts'
import { attachImages } from './attachments.ts'
import { contextHandlers } from './contextIpc.ts'
import { taskBriefs } from './briefs.ts'

import { newToken, startMcpServer, type ToolDef } from './mcp.ts'
import { answerText, listRules, nativePolicy, normalizePermissionSettings, PERMISSION_TOOL, PERMISSION_TOOL_NAME, PermissionBroker } from './permissions.ts'

import { runChat } from './runner.ts'
import { callTaskTool, childToolset, toolsFor, type ToolCtx } from './taskContext.ts'
import { ASK_TOOL_NAME, QuestionBroker } from './questions.ts'
import { canOpen, SEND_FILE_TOOL_NAME, sendUserFile, sharedInfo, sharedPath } from './sharedFiles.ts'
import { dismissSuggestion, listSuggestions, startSuggestion, suggestTask, SUGGEST_TOOL_NAME } from './suggestions.ts'
import { delegationReport, taskUsage } from './usage.ts'
import { finishRun, reconcileRuns } from './runs.ts'
import { projectInfo, run as gitRun } from './projectInfo.ts'
import { claudeProjects } from './claudeProjects.ts'
import { dropReceipts } from './workspaceTools.ts'
import { dropSkillSession, READ_SKILL_TOOL_NAME, setSkillRoots, skillTool } from './skills.ts'
import { markPublished, readDesk } from './linkedin.ts'
import type { JarvisSettings } from './jarvis.ts'
import { createTask, deleteTask, resetSession, getMetric, getSel, getTask, listTasks, profileOf, renameTask, saveMetric, saveSel, sessionOf, setArchived, setTaskState, taskForPin, taskMessages, TASK_STATES, type TaskSel } from './tasks.ts'

// macOS/Linux: app aberto fora do terminal nao ve o PATH do shell (claude, codex... instalados via npm/brew). No Windows nao faz nada.
const loginPath = loginShellPath()
if (loginPath) process.env.PATH = mergePath(loginPath, process.env.PATH)

// Falha ao abrir/migrar o banco: mostra o motivo, registra em diagnostics.log e sai sem alterar nada
// (a migracao e transacional e ja deixou uma copia .bak ao lado do banco).
// O lock nativo é por userData; sandboxes continuam independentes. Impede restaurar sobre outra instância aberta.
if (!app.requestSingleInstanceLock()) app.exit(0)
let lastRestore: { restoredAt: string; safetyPath: string } | null = null
function openOrQuit() {
  try {
    lastRestore = applyPendingRestore(app.getPath('userData'))
    return openDb(path.join(app.getPath('userData'), 'dashboard.db'))
  } catch (e: any) {
    logEvent(path.join(app.getPath('userData'), 'diagnostics.log'), { provider: 'app', category: 'config', detail: `banco: ${e?.message}` })
    dialog.showErrorBox('Nao foi possivel abrir os dados', `${e?.message}\n\nConsulte os backups e o diagnostics.log na pasta de dados do app (${app.getPath('userData')}).`)
    app.exit(1)
    throw e
  }
}
// Skills empacotadas (resources/skills) lidas sob demanda por read_task_skill: pasta do app (desenvolvimento e execucao do build) ou recursos do pacote.
setSkillRoots([path.join(app.getAppPath(), 'resources', 'skills'), path.join(process.resourcesPath ?? '', 'skills')])
setBlenderScriptRoots([path.join(app.getAppPath(), 'resources', 'blender'), path.join(process.resourcesPath ?? '', 'blender')])
const db = openOrQuit()
if (!db.prepare('SELECT 1 FROM accounts').get())
  db.prepare("INSERT INTO accounts (name, config_dir) VALUES ('Principal', NULL)").run()
reconcileRuns(db) // execucoes que ficaram 'running' de uma sessao anterior viram 'failed (interrompida)'
reconcileDelegations(db)
reconcileCommands(db)
reconcileSends(db) // mensagens retidas que a decisao humana nao alcancou antes do fechamento expiram (nada inicia; o texto continua recuperavel)
reconcileStarting(db)
reconcileSteps(db, true)
// Falha gravada por um build antigo que nao passava --skip-git-repo-check (ja corrigido): o painel nao deve acusar algo que nao acontece mais.
db.prepare("DELETE FROM settings WHERE key='lastError:codex' AND value LIKE '%--skip-git-repo-check was not specified%'").run()

const getSetting = (k: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) as any)?.value
const setSetting = (k: string, v: string) =>
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v)
const worktrees = createWorktreeService(db)

// Nomes de exibicao dados pelo usuario aos projetos (a pasta nunca e renomeada).
const projectNames = (): Record<string, string> => { try { return JSON.parse(getSetting('projectNames') ?? '{}') } catch { return {} } }

const IGNORED = new Set(['node_modules', '.git', '.worktrees', 'out', 'dist', 'build', '.godot', '.import', 'tmp', 'temp'])

function listGames(): string[] {
  const docs = app.getPath('documents').toLowerCase()
  const projects = claudeProjects(path.join(os.homedir(), '.claude.json'))
  const extra: string[] = JSON.parse(getSetting('extraGames') ?? '[]')
  const hidden: string[] = JSON.parse(getSetting('hiddenGames') ?? '[]')
  return pickGames({ docs, projects, extra, hidden, appPath: app.getAppPath(), isDir: p => fs.existsSync(p) && fs.statSync(p).isDirectory() })
}

function listDocs(root: string, dir = root, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || out.length > 2000) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { // links/junctions nao sao seguidos (isDirectory e falso para eles)
      if (IGNORED.has(e.name) || (e.name.startsWith('.') && e.name !== '.claude')) continue
      // Pula repositorios aninhados e worktrees (tem .git proprio).
      if (fs.existsSync(path.join(dir, e.name, '.git'))) continue
      listDocs(root, path.join(dir, e.name), depth + 1, out)
    } else if (/\.md$/i.test(e.name)) out.push(path.relative(root, path.join(dir, e.name)))
  }
  return out
}

// Assincrono, com timeout e sem janela no Windows: nada de Git sincrono na thread principal.
const git = async (cwd: string, ...args: string[]) => (await gitRun(cwd, args)).trim()

// Worktree so quando o usuario pede isolamento (nunca e requisito para conversar ou ler arquivos).
// `prefix`+`id` mantem os nomes antigos dos pins (pin-<id>-...) e usam task-<id>-... para tarefas novas.
async function createWorktree(game: string, prefix: 'pin' | 'task', id: number, title: string) {
  try { await git(game, 'rev-parse', '--is-inside-work-tree') } catch {
    throw new Error('A pasta do projeto nao e um repositorio git: nao da para isolar em worktree. Conversar e ler arquivos continua funcionando.')
  }
  const slug = title.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const wt = path.join(game, '.worktrees', `${prefix}-${id}-${slug}`)
  const branch = `${prefix}/${id}-${slug}`
  // Mantem .worktrees/ fora do git do jogo sem mexer no .gitignore dele.
  const exclude = path.join(path.resolve(game, await git(game, 'rev-parse', '--git-common-dir')), 'info', 'exclude')
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
  if (!cur.split(/\r?\n/).includes('.worktrees/')) fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}.worktrees/\n`)
  safeJoin(game, path.relative(game, wt))
  if (fs.existsSync(wt)) {
    if (!samePath(await git(wt, 'rev-parse', '--show-toplevel'), wt)
      || !samePath(path.resolve(wt, await git(wt, 'rev-parse', '--git-common-dir')), path.resolve(game, await git(game, 'rev-parse', '--git-common-dir')))
      || await git(wt, 'symbolic-ref', '--short', 'HEAD') !== branch
      || !(await git(game, 'worktree', 'list', '--porcelain', '-z')).split('\0').some(line => line.startsWith('worktree ') && samePath(line.slice(9), wt))) fail('A pasta de isolamento já existe e não corresponde à worktree da tarefa.')
    return { wt, branch, setup: null }
  }
  await gitRun(game, ['worktree', 'add', wt, '-b', branch], { timeout: 300_000 }) // checkout de projeto grande
  return { wt, branch, setup: copyNote(await copyIntoWorktree(game, wt, copyList(db, game))) } // .env, cache .godot/...: so o que o usuario listou
}

const { accountRow, dirKey, accountEnv, listAccounts, fetchUsage } = createAccounts(db)
const diagLog = path.join(app.getPath('userData'), 'diagnostics.log')
const attachRoot = path.join(app.getPath('userData'), 'attachments') // imagens coladas no chat, por tarefa (fora do projeto)
const sentDir = (taskId: number) => path.join(attachRoot, String(taskId), 'enviados') // copias de send_user_file
const logFor = (provider: string, profile?: string) => (e: Partial<LogEntry>) => logEvent(diagLog, { provider, profile, ...e })

// Provedores: instalacao, versao, capacidades e login. Consultas gratuitas, sem inferencia.
async function diagnose() {
  return Promise.all(Object.keys(AGENTS).map(async id => {
    const info = await probeProvider(id)
    const auth = id === 'claude' || !info.exe ? undefined : await providerAuth(id)
    return { ...info, auth, lastError: JSON.parse(getSetting(`lastError:${id}`) ?? 'null') }
  }))
}


// ---- Validacao dos argumentos vindos do renderer (a ponte IPC e generica).
// So projetos que o app lista (pasta do Claude Code em Documentos ou adicionada manualmente).
// Pagina LinkedIn: pasta propria do app (fora da lista de projetos) onde o agente guarda perfil, rascunhos e videos.
const linkedinDir = path.join(app.getPath('userData'), 'linkedin')
const asGame = (v: unknown) => asAllowedPath([...listGames(), linkedinDir], v, 'projeto')
const asPin = (v: unknown, game?: string) => {
  const pin = db.prepare('SELECT * FROM pins WHERE id=?').get(asInt(v, 'problema')) as any
  if (!pin || (game && path.resolve(pin.game).toLowerCase() !== game.toLowerCase())) fail('Problema inexistente neste projeto.')
  return pin
}
const taskDir = (t: { game: string; worktree: string | null }) => (t.worktree && fs.existsSync(t.worktree) ? t.worktree : t.game)
let filesWatch: { taskId: number; dir: string; off: () => void } | null = null // painel de arquivos: so a tarefa visivel
// Pulso da home: observa as pastas onde ha agente agora e mede cada rodada de gravacoes pelo git (sem IA).
const pulse = createPulse({
  watch: watchDir,
  sample: async dir => new Map((await changedFiles(dir)).files.map(f => [f.path, { a: f.added ?? 0, r: f.removed ?? 0 }])),
  onEvent: game => emit({ pulse: game }),
})
const asTask = (v: unknown) => getTask(db, asInt(v, 'tarefa')) ?? fail('Tarefa inexistente.')
// Execucao exige projeto listado; tarefas legadas sem projeto so permitem ler o historico.
const taskGame = (t: { game: string }) => (t.game ? asGame(t.game) : fail('Tarefa legada sem projeto: so o historico esta disponivel.'))

type Sel = TaskSel
const optArg = (v: unknown, what: string) => (v == null || v === '' ? undefined : typeof v === 'string' && SAFE_ARG.test(v) ? v : fail(`${what} invalido`))
function asSel(s: any): Sel {
  if (!s || typeof s !== 'object') fail('Selecao invalida')
  if (typeof s.provider !== 'string' || !Object.hasOwn(AGENTS, s.provider)) fail('Provedor desconhecido')
  const accountId = s.accountId == null ? undefined : asInt(s.accountId, 'conta')
  if (accountId && !accountRow(accountId)) fail('Conta inexistente')
  return { provider: s.provider, accountId, model: optArg(s.model, 'Modelo'), effort: optArg(s.effort, 'Esforco') }
}
// Base das CLIs sem o estado de uma sessao anfitria do Claude Code (ver providers.hostlessEnv); so os NOMES removidos vao ao diagnostico.
const host = hostlessEnv(process.env)
if (host.stripped.length) logEvent(diagLog, { provider: 'app', detail: `sessao anfitria do Claude Code detectada; nao repassadas as CLIs: ${host.stripped.join(', ')}` })
const envFor = (s: Sel) => (s.provider === 'claude' ? accountEnv(s.accountId) : host.env)
// Modelo/esforco so seguem para a CLI se constarem no catalogo (ou forem ids validos onde nao ha descoberta).
async function checkSel(s: Sel) {
  if (!s.model && !s.effort) return
  const err = validateSelection(await getCatalog(s.provider, envFor(s)), s.model, s.effort)
  if (err) fail(err)
}

// Pasta onde o agente roda: worktree da tarefa (se ela foi isolada) ou a pasta do projeto.
async function taskCwd(t: { game: string; worktree: string | null }) {
  const game = taskGame(t)
  if (!t.worktree) { await worktrees.assertAvailable(game); return game }
  if (!fs.existsSync(t.worktree)) fail('Worktree da tarefa ausente. Revise seu vínculo antes de executar novamente.')
  const real = fs.realpathSync(t.worktree)
  if (!inside(path.join(fs.realpathSync(game), '.worktrees'), real)) fail('Worktree da tarefa fora de .worktrees do projeto.')
  await worktrees.assertAvailable(t.worktree)
  return t.worktree
}

// Isolamento explicito. Sessoes nativas dependem da pasta de execucao, entao as da tarefa recomecam
// (o historico vai como contexto na proxima mensagem).
async function isolateTask(taskId: number) {
  const t = asTask(taskId)
  const game = taskGame(t)
  await worktrees.assertAvailable(game)
  if (t.worktree) { await taskCwd(t); return t }
  const { wt, branch, setup } = await createWorktree(game, t.pin_id ? 'pin' : 'task', t.pin_id ?? t.id, t.title)
  db.exec('BEGIN')
  let packages: number[]
  try {
    packages = resetWorkspace(db, [t.id], 'A pasta da tarefa mudou para uma worktree.').packageIds
    db.prepare('UPDATE tasks SET worktree=?, branch=? WHERE id=?').run(wt, branch, t.id)
    if (t.pin_id) db.prepare("UPDATE pins SET status='andamento', branch=?, worktree=? WHERE id=?").run(branch, wt, t.pin_id)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  for (const id of packages!) waiters.resolved(id, 'cancelled')
  note(t.id, `Tarefa isolada em worktree (${branch}). As sessões nativas recomeçam; o histórico só segue como contexto após sua aprovação.`)
  if (setup) db.prepare("INSERT INTO messages (chat_key, role, text, task_id) VALUES (?, 'system', ?, ?)").run(`task:${t.id}`, setup, t.id)
  emit({ worktreesChanged: game, refresh: true })
  return getTask(db, t.id)
}

async function launchTask(taskId: number, sel: Sel, resume: boolean, isolate: boolean) {
  let t = asTask(taskId)
  if (isolate) t = await isolateTask(t.id)
  const a = AGENTS[sel.provider]
  const cwd = await taskCwd(t)
  const sid = resume ? sessionOf(db, t.id, sel.provider, profileOf(sel.provider, sel.accountId)) : undefined
  const pin = t.pin_id ? (db.prepare('SELECT * FROM pins WHERE id=?').get(t.pin_id) as any) : null
  const prompt = pin ? `Resolva este problema do jogo. ${pin.title}. ${pin.body ?? ''}` : ''
  const args = sid ? a.resumeArgs(sid) : prompt ? a.promptArgs(prompt) : []
  openTerminal(cwd, `${sel.provider} - ${path.basename(cwd)}`, [a.cmd, ...args].join(' '), envFor(sel))
}

// ---- Chat: cada mensagem roda a CLI em modo headless e retoma EXATAMENTE a sessao gravada para
// (tarefa, provedor, perfil). O historico e da tarefa; trocar de provedor nao o esconde.
const childDoing = new Map<number, Doing>() // ferramenta atual de cada filho (delegacao) rodando: dock e chat
const active = new Map<number, { runId: number; cancel: (sync?: boolean) => void; text: string; workspace: string; provider?: string; model?: string; startedAt?: number; doing?: { tool: string; detail?: string } }>()
let win: BrowserWindow | undefined
app.on('second-instance', () => { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.focus() })

function taskChat(taskId: number, sel: Sel) {
  const t = asTask(taskId)
  const sessions = db.prepare('SELECT provider, profile FROM task_sessions WHERE task_id=?').all(t.id)
  return {
    task: t, running: active.has(t.id), awaitingContext: !!awaitingSend(db, t.id), live: active.get(t.id)?.text ?? '',
    session: sessionOf(db, t.id, sel.provider, profileOf(sel.provider, sel.accountId)) ?? null, sessions,
    sel: getSel(db, t.id), metric: getMetric(db, t.id, sel.provider, profileOf(sel.provider, sel.accountId)),
    messages: taskMessages(db, t.id)
  }
}

const pct = (w: any) => w && { utilization: w.utilization * 100, resets_at: new Date(w.resetsAt * 1000).toISOString() }
const send = (ev: object) => { if (win && !win.isDestroyed()) win.webContents.send('chat', ev) }
const emit = (ev: object) => { send(ev); try { attend(ev) } catch {} } // aviso e opcional: nunca derruba o evento

// Avisos de atencao (notify.ts). Com a Orbita em foco: cartao dentro do app. Fora de foco: janela propria de aviso no canto da tela
// (mesmo visual do app, sem roubar o foco) e a barra de tarefas pisca. Ao voltar para o app, o que ficou pendente vira cartao la dentro.
const notifyPrefs = () => normalizeNotify(JSON.parse(getSetting('notifications') ?? 'null'))
const { runStart, noticeInfo } = createNoticeInfo(db, projectNames, id => questions.get(id)) // questions e criado abaixo; so lido nos eventos

// Janela do planeta (sempre por cima, fora da barra de tarefas; comeca no canto inferior direito e o usuario arrasta para onde
// quiser): o planeta de uso fica visivel e se expande para virar o aviso quando ha algo com a Orbita fora de foco (ver Planet.tsx).
// Planeta desligado: a janela so aparece com aviso. Continua com a Orbita minimizada; fecha junto com ela para nao segurar o
// processo vivo. O renderer anima e informa o tamanho; aqui so posiciona.
let noticeWin: BrowserWindow | undefined
let noticeSeq = 0
const pendingNotices: Notice[] = [] // o que a janela do planeta esta mostrando
const NOTICE_W = 420, PLANET = 132 // NOTICE_W = largura de .corner .nw em planet.css
const toPopup = (ev: object) => { if (noticeWin && !noticeWin.isDestroyed()) noticeWin.webContents.send('chat', ev) }
const planetOn = () => getSetting('planet') !== 'off'
// Posicao do planeta (canto superior esquerdo do quadrado de 132 px). Salva fora de qualquer tela (monitor removido) volta ao canto.
function planetBox() {
  let p: { x: number; y: number } | null = null
  try { p = JSON.parse(getSetting('planetPos') ?? 'null') } catch {}
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    const wa = screen.getDisplayNearestPoint({ x: Math.round(p.x + PLANET / 2), y: Math.round(p.y + PLANET / 2) }).workArea
    if (p.x >= wa.x && p.y >= wa.y && p.x + PLANET <= wa.x + wa.width && p.y + PLANET <= wa.y + wa.height) return { ...p, wa }
  }
  // Tela da Orbita (GPD_DISPLAY no e2e: segundo monitor).
  const wa = (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getAllDisplays()[Number(process.env.GPD_DISPLAY) - 1] ?? screen.getPrimaryDisplay()).workArea
  return { x: wa.x + wa.width - PLANET - 8, y: wa.y + wa.height - PLANET - 8, wa }
}
// Para que lado o aviso abre (na direcao do centro da tela; ver planetLayout).
function planetState() {
  const b = planetBox(), { right, bottom } = planetLayout(b, b.wa, PLANET)
  return { on: planetOn(), right, bottom }
}
function noticeWindow() {
  if (noticeWin && !noticeWin.isDestroyed()) return noticeWin
  noticeWin = new BrowserWindow({
    width: PLANET, height: PLANET, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, title: 'Órbita: planeta',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' }
  })
  noticeWin.setAlwaysOnTop(true, 'pop-up-menu')
  noticeWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  noticeWin.webContents.on('will-navigate', e => e.preventDefault())
  noticeWin.on('closed', () => { noticeWin = undefined })
  noticeWin.once('ready-to-show', () => fitNotices(0))
  if (rendererUrl) noticeWin.loadURL(`${rendererUrl}#planet`)
  else noticeWin.loadFile(rendererFile, { hash: 'planet' })
  return noticeWin
}
// Com aviso a janela cresce a partir do planeta (que fica no mesmo lugar da tela); sem aviso (ou depois da animacao de fechar),
// volta ao quadrado do planeta, ou some se o planeta estiver desligado.
function fitNotices(height: number) {
  const w = noticeWin
  if (!w || w.isDestroyed()) return
  const b = planetBox(), notice = pendingNotices.length > 0 && height > 0
  w.setBounds(planetLayout(b, b.wa, PLANET, notice ? { width: NOTICE_W, height } : undefined).bounds)
  if (!notice && !planetOn()) { w.hide(); return }
  if (!w.isVisible()) w.showInactive()
}
function showNotice(base: Omit<Notice, 'key'>, prefs: NotifyPrefs, force = false) {
  const n: Notice = { ...base, key: ++noticeSeq }
  const away = !win || win.isDestroyed() || !win.isFocused()
  if ((!away && !force) || !prefs.system) { send({ attention: n }); return }
  pendingNotices.unshift(n)
  if (pendingNotices.length > 6) pendingNotices.pop()
  noticeWindow()
  toPopup({ attention: n, sound: prefs.sound })
  if (away && win && !win.isDestroyed()) win.flashFrame(true)
}
// Voltou para o app: o aviso volta a ser planeta e o que ninguem abriu continua visivel como cartao dentro da Orbita.
function noticesToApp() {
  if (!pendingNotices.length) return
  for (const n of pendingNotices.splice(0).reverse()) if (n.taskId > 0) send({ attention: n })
  toPopup({ noticeClear: true })
}
function attend(ev: any) {
  if (!ev?.done && !ev?.permissionRequest && !ev?.questionRequest && !ev?.contextRequest && !ev?.commandDone) return
  const prefs = notifyPrefs()
  noticeInfo(ev).then(info => { const n = noticeFor(ev, info, prefs); if (n) showNotice(n, prefs) }).catch(() => {})
}

// Uso das contas em uso, uma entrada por conta (o planeta alterna entre elas). O endpoint do Claude recusa excesso: consulta
// a rede no maximo a cada 10 min; entre uma e outra usa o ultimo valor visto (que o chat tambem atualiza). Codex vem das
// sessoes locais, sem rede.
async function usageForPlanet() {
  const list = inUse(db)
  const claude = list.flatMap(u => (u.provider === 'claude' && accountRow(u.accountId) ? [u.accountId] : []))
  await Promise.allSettled(claude.map(id => accountUsage(id))) // o servico so consulta de novo depois de USAGE_TTL; a resposta aparece no proximo ciclo de 30 s
  const cached = (id: number) => accountUsageService.snapshot(id)
  const many = (db.prepare('SELECT COUNT(*) n FROM accounts').get() as any).n > 1 // com uma conta so, o nome dela nao diz nada
  return list.flatMap(u => {
    if (u.provider === 'codex') return [{ key: 'codex', ...planetUsage('Codex', codexLimits()) }]
    const name = accountRow(u.accountId)?.name
    return name ? [{ key: `claude:${u.accountId}`, ...planetUsage(many ? `Claude, ${name}` : 'Claude', cached(u.accountId)) }] : []
  })
}

// Junta o que o provedor informou com fontes nativas complementares: arquivo de sessao do Codex (contexto e janela) e
// janela do modelo no catalogo do opencode. Nada e estimado a partir do texto visivel.
function recordMetric(taskId: number, sel: Sel, profile: string, session: string | undefined, metric: Metric | undefined) {
  let m: Metric | undefined = metric && { ...metric }
  if (sel.provider === 'codex' && session) {
    const file = findRollout(session)
    const c = file ? codexContextFromRollout(file) : null
    if (c) m = { ...(m ?? { source: c.source }), occupied: c.occupied, capacity: c.capacity, estimated: c.estimated, source: m ? `${c.source} + ${m.source}` : c.source }
  }
  if (m && m.capacity === undefined && sel.provider === 'opencode' && sel.model) {
    const w = peekCatalog('opencode')?.models.find(x => x.id === sel.model)?.contextWindow
    if (w) m = { ...m, capacity: w, source: `${m.source} + janela do catalogo (opencode models)` }
  }
  if (m) saveMetric(db, taskId, sel.provider, profile, sel.model ?? null, sel.effort ?? null, m)
}

// ---- Delegacao: ferramenta MCP local (um token por execucao do pai; filhos nao recebem a ferramenta).
const guard = new WorkspaceGuard()
const waiters = new ApprovalWaiters()
// Token por execucao: pai (delegar + contexto) ou filho (contexto + operacoes locais; nunca delegar).
// perm: a ferramenta `permission_prompt` (pop-up de permissao) so e anunciada a execucoes do Claude que a receberam por --permission-prompt-tool.
type McpCtx = { kind: 'parent'; p: ParentCtx; perm: boolean } | { kind: 'child'; t: ToolCtx; perm: boolean; tools: ToolDef[]; engines?: EngineGrants } // tools: o que ESTE filho recebeu (childToolset)
const tokens = new Map<string, McpCtx>()
const permissionSettings = () => normalizePermissionSettings(JSON.parse(getSetting('permissions') ?? 'null'))
const broker = new PermissionBroker(db, { settings: permissionSettings, providers: Object.keys(AGENTS), emit: ev => emit(ev) })
broker.expire() // reinicio: pedidos que ficaram pendentes nao tem mais CLI esperando
db.prepare('DELETE FROM permission_requests WHERE id NOT IN (SELECT id FROM permission_requests ORDER BY id DESC LIMIT 2000)').run() // auditoria limitada
const nativeFor = (provider: string) => nativePolicy(provider, permissionSettings(), listRules(db, provider))
const mcpDir = () => path.join(app.getPath('userData'), 'mcp')
const delegationSettings = () => normalizeSettings(JSON.parse(getSetting('delegation') ?? 'null'))
const storedLimits = () => normalizeLimits(JSON.parse(getSetting('contextLimits') ?? 'null'))
const contextLimits = () => effectiveLimits(storedLimits()) // Configuracoes mostra o guardado; os servicos usam o efetivo
const summaryTitles = () => getSetting('summaryTitles') !== 'off'
const agentAliases = () => { try { return parseAliases(JSON.parse(getSetting('agentAliases') ?? '[]')) } catch { return [] } } // agentes nomeados (Configuracoes)
const parentTool = (p: ParentCtx): ToolCtx => ({ taskId: p.taskId, lineage: p.lineage, auth: p.auth, role: 'parent', cwd: p.cwd, scope: [], runId: p.runId })
// Engines (Godot/Unity/Blender) concedidas pelo organizador: revalidadas a cada anúncio e consulta.
const ctxGrants = (c: McpCtx) => c.kind === 'parent' ? liveGrants(db, c.p.taskId, c.p.cwd, c.p.engines) : liveGrants(db, c.t.taskId, c.t.cwd, c.engines)
const sameDir = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const note = (taskId: number, text: string) => {
  db.prepare("INSERT INTO messages (chat_key, role, text, task_id) VALUES (?, 'system', ?, ?)").run(`task:${taskId}`, text, taskId)
  emit({ taskId, refresh: true })
}
// Perguntas do agente pai ao usuario (ask_user): mesmo prazo que o timeout do cliente MCP ja cobre (chatService).
const questions = new QuestionBroker({ timeoutMin: () => Math.max(contextLimits().approvalTimeoutMin, permissionSettings().timeoutMin), emit: ev => emit(ev), note })
const delegationDeps: Deps = {
  db, guard, settings: delegationSettings, limits: contextLimits, aliases: agentAliases, nativePolicy: nativeFor, waiters, note,
  // A interface mostra o pedido (pacote exato + destinatario); aqui so avisamos no chat e emitimos o evento. Nada foi enviado ao destinatario.
  onContextRequest: pkg => {
    note(pkg.task_id, `↳ Pedido de contexto #${pkg.id} aguardando sua aprovacao: ${pkg.items.length} item(ns), ${pkg.size} caracteres, para ${pkg.recipient.provider}${pkg.recipient.model ? `/${pkg.recipient.model}` : ''}. Nada foi enviado ao destinatario.`)
    emit({ taskId: pkg.task_id, contextRequest: pkg.id })
  },
  catalogCheck: async (provider, model, effort) => validateSelection(await getCatalog(provider, envFor({ provider }), false), model, effort),
  envFor: (provider, accountId) => envFor({ provider, accountId }),
  otherTasksActiveIn: (ws, taskId) => commands.busy(ws) || [...active].some(([id, r]) => id !== taskId && sameDir(r.workspace, ws)),
  runChild: ({ provider, opts, cwd, env, input, session, delegationId }) => {
    const a = AGENTS[provider]
    const run = runChat({ cmd: a.cmd, args: a.chatArgs(session, opts), cwd, env, parse: a.parse, input, onTool: (tool, detail) => childDoing.set(delegationId, { tool: tool.slice(0, 80), detail }) })
    run.result.finally(() => childDoing.delete(delegationId)).catch(() => {})
    return run
  },
  // Filhos recebem so as ferramentas de contexto/area de trabalho do papel (nunca delegar). Gemini nao le MCP por execucao: sem consulta incremental.
  childTools: async p => {
    const token = newToken()
    let wire: McpWire | null = null
    const perm = p.provider === 'claude' && permissionSettings().prompt
    const grants = liveGrants(db, p.taskId, p.cwd, p.engines)
    const set = childToolset(p.provider, p.mode, p.scope, grantedEngines(grants))
    set.mcp.push(...grantedTools(grants))
    try { wire = mcpWire(p.provider, { url: (await getMcp()).url, token, timeoutSec: 600, dir: mcpDir(), tools: set.mcp.map(x => x.name), permission: perm, strict: p.mode === 'read' }) } catch { return null }
    if (!wire) return null
    tokens.set(token, { kind: 'child', perm, tools: set.mcp, engines: grants, t: { taskId: p.taskId, lineage: p.lineage, auth: p.auth, role: 'child', cwd: p.cwd, scope: p.scope, delegationId: p.delegationId, provider: p.provider } })
    const w = wire
    // Recibos e skills entregues valem para a SESSAO: continuam so se a execucao terminou comprovadamente nela (continuacao do mesmo filho).
    return { extra: w.extra, env: w.env, tools: set.mcp.map(x => x.name), ...(set.native ? { native: set.native } : {}), cleanup: keep => { tokens.delete(token); if (!keep) { dropReceipts(p.auth.authId); dropSkillSession(p.auth.authId) } w.cleanup() } }
  }
}
let mcpServer: ReturnType<typeof startMcpServer<McpCtx>> | undefined
const getMcp = () => (mcpServer ??= startMcpServer<McpCtx>({
  tools: c => {
    const grants = ctxGrants(c), live = grantedTools(grants)
    // Filho: o conjunto fixado ao iniciar, menos engines revogadas depois (e a lista de skills de engine revogadas).
    const base = c.kind === 'parent' ? [...toolsFor('parent', delegationSettings().enabled ? delegateTool(agentAliases(), delegationSettings().readAgent) : undefined, grantedEngines(grants)), ...live]
      : c.tools.filter(t => !engineOf(t.name) || live.some(l => l.name === t.name)).map(t => t.name === READ_SKILL_TOOL_NAME ? skillTool('child', grantedEngines(grants)) : t)
    return [...base, ...(c.perm ? [PERMISSION_TOOL] : [])]
  },
  authorize: t => tokens.get(t) ?? null,
  call: async (c, name, args, signal) => {
    if (name === PERMISSION_TOOL_NAME) { // a CLI pergunta antes de uma acao que exigiria permissao; regra decide ou o pop-up pergunta ao usuario
      const p = c.kind === 'parent' ? { provider: c.p.provider, taskId: c.p.taskId, runId: c.p.runId, cwd: c.p.cwd } : { provider: c.t.provider ?? 'claude', taskId: c.t.taskId, delegationId: c.t.delegationId, cwd: c.t.cwd }
      return { text: answerText(await broker.handle(p, args, signal)), isError: false }
    }
    if (c.kind === 'parent' && name === TOOL_NAME) return runDelegation(delegationDeps, c.p, args, signal)
    if (c.kind === 'parent' && name === ASK_TOOL_NAME) return questions.ask({ taskId: c.p.taskId, runId: c.p.runId, provider: c.p.provider }, args, signal)
    if (c.kind === 'parent' && name === SUGGEST_TOOL_NAME) {
      const r = suggestTask(db, { taskId: c.p.taskId, runId: c.p.runId, provider: c.p.provider }, args)
      if (!r.isError) emit({ taskId: c.p.taskId, suggestion: true })
      return r
    }
    if (c.kind === 'parent' && name === SEND_FILE_TOOL_NAME) {
      const { note: text, ...r } = sendUserFile(c.p.cwd, sentDir(c.p.taskId), args)
      if (text) note(c.p.taskId, text)
      return r
    }
    if (c.kind === 'child' && !c.tools.some(t => t.name === name)) return { text: 'Ferramenta nao anunciada para esta execucao.', isError: true }
    const grants = ctxGrants(c), tctx = { ...(c.kind === 'parent' ? parentTool(c.p) : c.t), engines: grantedEngines(grants) }
    if (engineOf(name)) return callEngineTool(db, contextLimits(), tctx, grants, name, args, signal)
    return callTaskTool(db, contextLimits(), tctx, name, args)
  }
}))

// A checagem Git (assertAvailable) do destino roda em beforeSpawn, via taskCwd, antes da trava e de novo antes do spawn.
const commands = createCommandService(db, guard, cwd => [...active.values()].some(r => sameDir(r.workspace,cwd)) || (db.prepare("SELECT 1 FROM delegations WHERE status='running' AND workspace=?").get(cwd) != null), emit, {
  beforeSpawn: async (taskId, game, cwd, command) => { if (!samePath(await taskCwd(asTask(taskId)), cwd)) fail('A pasta da tarefa mudou. Prepare o comando novamente.'); validatePreparedGodot(db, game, cwd, command); validatePreparedEngine(db, game, cwd, command) },
  resultError: (command, output, truncated, cwd) => godotCommandError(command, output, truncated) ?? engineCommandError(command, output, truncated, cwd)
})

const { sendTask, decideSend: decideChatSend } = createChatService({
  db, active, guard, broker, asTask, taskCwd, checkSel, contextLimits, delegationSettings, permissionSettings,
  getMcp, mcpDir, nativeFor, envFor, emit, note, logFor, accountRow, setSetting, recordMetric, attachRoot, linkedinDir,
  workspaceBusy: commands.busy, onRunStart: runStart, summaryTitles,
  accountUsageWriter: id => accountUsageService.writer(id),
  engineGrants: (game, cwd) => engineGrants(db, game, cwd),
  onFinished: o => handover(o), questions,
  registerParent: (token, p, perm) => { tokens.set(token, { kind: 'parent', p, perm }) },
  unregisterToken: token => { tokens.delete(token) }
})

// Ao fechar o app: cancela os processos ativos e grava o estado 'cancelled' (com o texto parcial).
app.on('before-quit', () => {
  commands.stopAll()
  for (const r of active.values()) {
    r.cancel(true) // sincrono: o app sai logo depois e o taskkill precisa terminar antes
    finishRun(db, r.runId, { status: 'cancelled', text: r.text, notes: [] })
  }
  active.clear()
  mcpServer?.then(m => m.close()).catch(() => {})
  pulse.stop(); stopWatching()
})
// Depois das gravacoes de before-quit: esvazia o -wal para o .db ficar completo com o app fechado (copias cruas, restauracao).
app.on('will-quit', () => { try { checkpointDb(db) } catch {} })

// Snapshot persistido primeiro; refresh opcional compartilhado entre chat, limites e configuracoes.
const accountUsageService = createAccountUsageService({
  identity: id => {
    const acc = accountRow(id)
    return acc && loginState(dirKey(acc))?.state !== 'connecting' ? createHash('sha256').update(dirKey(acc)).digest('hex') : null
  },
  read: (id, identity) => {
    const profile = getSetting(`usageProfile:${id}`)
    if (profile && profile !== identity) return null
    try { return JSON.parse(getSetting(`usage:${id}`) ?? 'null') } catch { return null }
  },
  write: (id, identity, usage) => {
    setSetting(`usageProfile:${id}`, identity)
    setSetting(`usage:${id}`, JSON.stringify(usage))
  },
  clear: id => { db.prepare('DELETE FROM settings WHERE key IN (?,?)').run(`usage:${id}`, `usageProfile:${id}`) },
  request: fetchUsage,
  emit: (accountId, usage) => emit({ accountUsage: { accountId, usage } }),
  refreshGuard: work => backups.invoke(work)
})
const accountUsage = (accountId: number) => accountUsageService.get(accountId)
const automations = createAutomations({
  getSetting, setSetting, usage: id => accountUsageService.snapshot(id), accountName: id => accountRow(id)?.name ?? `conta ${id}`,
  peers: id => { const me = accountRow(id); return listAccounts().filter(a => a.id !== id && (!me || dirKey(a) !== dirKey(me))).map(a => a.id) } // mesma pasta = mesmo login
})
const handoverSettings = () => { try { return normalizeHandover(JSON.parse(getSetting('handover') ?? 'null')) } catch { return normalizeHandover(null) } }
const handover = createHandover({
  db, mode: () => handoverSettings().mode, itemChars: () => contextLimits().itemChars, note, emit, sendTask: (id, s, text) => sendTask(id, s, text),
  peers: id => automations.peers(id), usage: id => accountUsageService.snapshot(id), accountName: id => accountRow(id)?.name ?? `conta ${id}`
})
// Perfis antigos podem compartilhar a mesma pasta: trocar login invalida todas essas contas.
const invalidateAccountUsage = (account: any) => {
  for (const acc of listAccounts()) if (dirKey(acc) === dirKey(account)) accountUsageService.invalidate(acc.id)
}

const { liStatus, liConnect, liPost, cancelConnect } = createLinkedInService({ getSetting, setSetting, safeStorage, openExternal: url => shell.openExternal(url), linkedinDir })

const PIN_STATUS = ['aberto', 'andamento', 'feito']
// Cada handler valida seus argumentos: o renderer so deve conseguir o que a UI oferece.
// ---- Jarvis: uma pergunta por vez, pela CLI do Claude ja logada (assinatura da conta escolhida). Roda numa pasta propria e vazia,
// so com ferramentas de leitura: responde a partir do retrato montado aqui, nunca mexe em projeto.
const { askJarvis, jarvisSettings, stopJarvis } = createJarvisService({
  db, getSetting, accountRow, checkSel, listGames, projectNames, listActive: () => handlers.listActive(), envFor, emit, logFor, dataDir: app.getPath('userData')
})

async function decideSend(id: number, hash: string, decision: Decision, keep?: string[]) {
  const step = db.prepare("SELECT id FROM task_steps WHERE send_id=? AND state='awaiting_context'").get(id) as { id: number } | undefined
  const taskId = (db.prepare('SELECT task_id FROM pending_sends WHERE id=?').get(id) as { task_id: number } | undefined)?.task_id // etapas da tarefa recarregam so com evento dela
  try {
    const result = await decideChatSend(id, hash, decision, keep)
    if (step && 'runId' in result && result.runId) bindStep(db, step.id, { status: 'started', runId: result.runId })
    return result
  } finally { reconcileSteps(db); emit({ taskId, refresh: true }) }
}


const worktreeFolder = async (game: string, dir: unknown) => {
  const v = await worktrees.view(asGame(game)), p = asStr(dir, 'pasta', 4000)
  return [v.target, ...v.sources].find(s => samePath(s.path, p))?.path ?? fail('Worktree não registrada neste projeto.')
}
const worktreeChange = async (game: string, fn: (game: string) => Promise<unknown>) => {
  const g = asGame(game)
  try { return await fn(g) } finally { emit({ worktreesChanged: g, refresh: true }) }
}
const finishWorktreeRemoval = (game: string, removed: string) => {
  db.exec('BEGIN')
  let affected: ReturnType<typeof unlinkWorktree>
  try {
    affected = unlinkWorktree(db, removed)
    worktrees.ackRemoval(game, removed)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  if (filesWatch && samePath(filesWatch.dir, removed)) { filesWatch.off(); filesWatch = null }
  for (const id of affected.packageIds) waiters.resolved(id, 'cancelled')
  for (const id of affected.taskIds) note(id, 'Worktree integrada e removida. A tarefa continua na pasta principal com sessões novas; mensagens e evidências foram preservadas.')
  emit({ worktreesChanged: game, removedPath: removed, refresh: true })
}

const backups = backupGate(() => {
  if (active.size || db.prepare("SELECT 1 FROM delegations WHERE status IN ('running','awaiting_context_approval') UNION SELECT 1 FROM command_runs WHERE status='running' UNION SELECT 1 FROM runs WHERE status='running' UNION SELECT 1 FROM pending_sends WHERE state='starting' LIMIT 1").get()
    || listAccounts().some(a => a.login?.state === 'connecting')) fail('Pare as execuções e conclua os logins antes da manutenção dos dados.')
})
let selectedBackup: { token: string; folder: string; manifestHash: string } | null = null
const manifestHash = (folder: string) => {
  const file = path.join(folder, 'manifest.json')
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 32 * 1024 * 1024) fail('Manifesto de backup inválido.')
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const productionIpc = createProductionIpc({
  db, dir: path.join(app.getPath('userData'), 'production'), asGame, asTask, taskCwd, emit, backups,
  openFile: p => dialog.showOpenDialog({ properties: ['openFile'], defaultPath: p }).then(r => (r.canceled ? null : r.filePaths[0] ?? null)),
  saveFile: f => dialog.showSaveDialog({ title: 'Exportar cópia aprovada', defaultPath: path.join(app.getPath('downloads'), f) }).then(r => (r.canceled ? null : r.filePath || null)),
})
const { productionChange, registerProjectBuild } = productionIpc
const handlers: Record<string, (...a: any[]) => any> = {
  backupInfo: () => ({ dataDir: app.getPath('userData'), lastRestore }),
  createBackup: () => backups.exclusive(async () => {
    const r = await dialog.showOpenDialog({ title: 'Escolher onde guardar o backup', properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('documents') })
    if (r.canceled || !r.filePaths[0]) return null
    return createBackup(db, app.getPath('userData'), r.filePaths[0])
  }),
  selectBackup: () => backups.exclusive(async () => {
    selectedBackup = null
    const r = await dialog.showOpenDialog({ title: 'Selecionar pasta de backup', properties: ['openDirectory'], defaultPath: app.getPath('documents') })
    if (r.canceled || !r.filePaths[0]) return null
    const hash = manifestHash(r.filePaths[0]), summary = inspectBackup(r.filePaths[0]), token = newToken()
    if (manifestHash(summary.path) !== hash) fail('O backup mudou durante a verificação. Selecione novamente.')
    selectedBackup = { token, folder: summary.path, manifestHash: hash }
    return { ...summary, token }
  }),
  restoreBackup: (token: unknown) => {
    const selected = selectedBackup ?? fail('Selecione e confira o backup antes de restaurar.')
    if (asStr(token, 'backup', 200) !== selected.token) fail('Selecione e confira o backup antes de restaurar.')
    return backups.exclusive(async () => {
      if (manifestHash(selected.folder) !== selected.manifestHash) fail('O backup mudou. Selecione novamente para conferir.')
      const r = await dialog.showMessageBox({ type: 'warning', title: 'Restaurar backup', message: 'Substituir os dados atuais e reiniciar a Órbita?',
        detail: `Backup: ${selected.folder}\n\nUma cópia de segurança será guardada antes da troca. Credenciais não serão restauradas. As conversas começarão sessões de IA novas.`,
        buttons: ['Cancelar', 'Restaurar e reiniciar'], defaultId: 0, cancelId: 0, noLink: true })
      if (r.response !== 1) return false
      if (manifestHash(selected.folder) !== selected.manifestHash) fail('O backup mudou. Selecione novamente para conferir.')
      stageRestore(app.getPath('userData'), selected.folder)
      selectedBackup = null; backups.restarting()
      setTimeout(() => { app.relaunch(); app.quit() }, 100)
      return true
    })
  },
  ...productionIpc.handlers,
  projectCommands: (game: string) => projectCommands(db, asGame(game)),
  ...engineHandlers({ db, asTask, taskCwd, emit, productionChange, registerProjectBuild }),
  worktreeCopy: async (game: string) => { const g = asGame(game); return { list: copyList(db, g), suggestions: await copySuggestions(g) } },
  saveWorktreeCopy: (game: string, raw: unknown) => saveCopyList(db, asGame(game), raw),
  worktreeView: (game: string) => worktrees.view(asGame(game)),
  previewWorktreeMerge: (game: string, source: unknown) => worktrees.previewMerge(asGame(game), asStr(source, 'worktree', 4000)),
  beginWorktreeMerge: (game: string, source: unknown, token: unknown) => backups.exclusive(() => worktreeChange(game, g => worktrees.beginMerge(g, asStr(source, 'worktree', 4000), asStr(token, 'prévia', 100))), true),
  finishWorktreeMerge: (game: string, token: unknown) => backups.exclusive(() => worktreeChange(game, g => worktrees.finishMerge(g, asStr(token, 'revisão', 100))), true),
  abortWorktreeMerge: (game: string, token: unknown) => backups.exclusive(() => worktreeChange(game, g => worktrees.abortMerge(g, asStr(token, 'revisão', 100))), true),
  dismissWorktreeMerge: (game: string, token: unknown) => backups.exclusive(() => worktreeChange(game, g => worktrees.dismissMerge(g, asStr(token, 'revisão', 100))), true),
  previewWorktreeRemoval: (game: string, source: unknown) => worktrees.previewRemoval(asGame(game), asStr(source, 'worktree', 4000)),
  removeWorktree: (game: string, source: unknown, token: unknown) => backups.exclusive(() => worktreeChange(game, async g => {
    const result = await worktrees.remove(g, asStr(source, 'worktree', 4000), asStr(token, 'prévia', 100))
    finishWorktreeRemoval(g, result.path)
    return result
  }), true),
  finishWorktreeRemoval: (game: string) => backups.exclusive(() => worktreeChange(game, async g => {
    const result = await worktrees.recoverRemoval(g)
    finishWorktreeRemoval(g, result.path)
    return result
  }), true),
  openWorktreeFolder: async (game: string, dir: unknown) => shell.openPath(await worktreeFolder(game, dir)),
  openWorktreeTerminal: async (game: string, dir: unknown) => openTerminal(await worktreeFolder(game, dir), 'Resolver integração', process.platform === 'linux' ? ':' : '', host.env),
  saveProjectCommands: (game: string, raw: unknown) => { const g = asGame(game), c = saveCommands(db, g, raw); emit({ game: g, commandConfigChanged: true }); return c },
  listCommandRuns: (taskId: number) => listCommandRuns(db, asTask(taskId).id),
  commandOutput: (taskId: number, id: number, offset: number = 0) => commands.output(asTask(taskId).id, asInt(id, 'execução'), offset),
  runProjectCommand: async (taskId: number, name: string) => { const t = asTask(taskId); return commands.start(t.id,t.game,await taskCwd(t),asStr(name,'comando',100)) },
  cancelProjectCommand: (taskId: number, id: number) => { const t = asTask(taskId), n = asInt(id,'execução'); if (!listCommandRuns(db,t.id).some(r => r.id===n)) fail('Comando de outra tarefa.'); commands.cancel(n) },
  listSteps: (taskId: number) => listSteps(db, asTask(taskId).id),
  addStep: (taskId: number, title: unknown, instruction: unknown) => { const t = asTask(taskId), id = addStep(db, t.id, title, instruction); emit({ taskId: t.id, refresh: true }); return id },
  reviewStep: (id: number, accept: unknown) => { if (typeof accept !== 'boolean') fail('Decisão inválida.'); const n = asInt(id, 'etapa'); reviewStep(db, n, accept as boolean); emit({ taskId: (db.prepare('SELECT task_id FROM task_steps WHERE id=?').get(n) as { task_id: number } | undefined)?.task_id, refresh: true }) }, // o painel de etapas recarrega so com eventos da propria tarefa
  todoBoard: (legacy?: unknown) => todoBoard(db, legacy),
  saveTodo: (revision: unknown, topics: unknown) => { const board = saveTodo(db, revision, topics); emit({ todoChanged: true }); return board },
  todoTask: (topicId: string, itemId: string, game: string) => {
    const result = todoTask(db, asStr(topicId, 'tópico', 80), asStr(itemId, 'item', 80), asGame(game))
    emit({ todoChanged: true, refresh: true }); return result
  },
  listGames,
  addGame: async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: app.getPath('documents') })
    if (r.canceled) return null
    const extra: string[] = JSON.parse(getSetting('extraGames') ?? '[]')
    if (!extra.includes(r.filePaths[0])) setSetting('extraGames', JSON.stringify([...extra, r.filePaths[0]]))
    const key = path.resolve(r.filePaths[0]).toLowerCase(), hidden: string[] = JSON.parse(getSetting('hiddenGames') ?? '[]')
    setSetting('hiddenGames', JSON.stringify(hidden.filter(h => path.resolve(h).toLowerCase() !== key))) // adicionar de novo desfaz o "remover da lista"
    return r.filePaths[0]
  },
  // So tira da lista de projetos: pasta, tarefas e historico ficam intactos.
  hideGame: (game: string) => {
    const g = asGame(game), hidden: string[] = JSON.parse(getSetting('hiddenGames') ?? '[]')
    setSetting('hiddenGames', JSON.stringify([...hidden, g]))
  },
  // Pastas tiradas da lista (Configuracoes): so as que ainda existem; restaurar e o inverso de hideGame.
  listHidden: () => (JSON.parse(getSetting('hiddenGames') ?? '[]') as string[]).filter(p => fs.existsSync(p)),
  unhideGame: (p: string) => {
    const key = path.resolve(asStr(p, 'pasta', 500)).toLowerCase(), hidden: string[] = JSON.parse(getSetting('hiddenGames') ?? '[]')
    setSetting('hiddenGames', JSON.stringify(hidden.filter(h => path.resolve(h).toLowerCase() !== key)))
  },
  listDocs: (game: string) => listDocs(asGame(game)),
  readDoc: (game: string, rel: string) => fs.readFileSync(safeJoin(asGame(game), asStr(rel, 'arquivo', 500)), 'utf8'),
  writeDoc: (game: string, rel: string, text: string) => createDoc(asGame(game), asStr(rel, 'arquivo', 500), asStr(text, 'texto', 200_000)), // so cria
  editDoc: (game: string, rel: string, seen: string, text: string) =>
    editDoc(asGame(game), asStr(rel, 'arquivo', 500), asStr(seen, 'texto lido', 200_000), asStr(text, 'texto', 200_000)),
  listPins: (game: string) => db.prepare('SELECT * FROM pins WHERE game=? ORDER BY id DESC').all(asGame(game)),
  addPin: (game: string, title: string, body: string) =>
    db.prepare('INSERT INTO pins (game,title,body) VALUES (?,?,?)').run(asGame(game), asStr(title, 'titulo', 300).trim() || fail('titulo vazio'), asStr(body ?? '', 'detalhes', 20_000)),
  setPinStatus: (id: number, status: string) => {
    if (!PIN_STATUS.includes(status)) fail('status invalido')
    db.prepare('UPDATE pins SET status=? WHERE id=?').run(status, asPin(id).id)
  },
  deletePin: (id: number) => {
    const pin = asPin(id)
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE project_playtests SET pin_id=NULL WHERE pin_id=?').run(pin.id)
      db.prepare('UPDATE tasks SET pin_id=NULL WHERE pin_id=?').run(pin.id)
      db.prepare('DELETE FROM pins WHERE id=?').run(pin.id)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    emit({ productionChanged: true, game: pin.game })
  },
  listAccounts,
  // A pasta deriva do id interno, nunca do nome (nomes diferentes davam a mesma pasta). Perfis antigos mantem a deles.
  addAccount: (name: string) => {
    const id = Number(db.prepare("INSERT INTO accounts (name, config_dir) VALUES (?, '')").run(asStr(name, 'nome', 80).trim() || fail('nome vazio')).lastInsertRowid)
    const dir = path.join(os.homedir(), `.claude-account-${id}`)
    fs.mkdirSync(dir, { recursive: true })
    db.prepare('UPDATE accounts SET config_dir=? WHERE id=?').run(dir, id)
  },
  accountStatus: (id: number) => claudeStatus(accountEnv(asInt(id, 'conta'))),
  loginAccount: (id: number) => {
    const acc = accountRow(asInt(id, 'conta')) ?? fail('Conta inexistente.')
    invalidateAccountUsage(acc)
    startLogin(dirKey(acc), accountEnv(acc.id), logFor('claude', acc.name))
  },
  cancelLogin: (id: number) => {
    const acc = accountRow(asInt(id, 'conta')) ?? fail('Conta inexistente.')
    cancelLogin(dirKey(acc)); invalidateAccountUsage(acc)
  },
  diagnose,
  accountUsage: (id: number) => accountUsage(accountRow(asInt(id, 'conta'))?.id ?? fail('Conta inexistente.')),
  accountUsageSnapshot: (id: number) => accountUsageService.snapshot(accountRow(asInt(id, 'conta'))?.id ?? fail('Conta inexistente.')),
  codexUsage: () => codexLimits(), // lido das sessoes locais do Codex: sem rede, sem tokens
  projectIcon: (game: string) => projectIconData(asGame(game)),
  // Arquivos da tarefa ao vivo (fs.watch + git; sem IA, sem tokens). So a tarefa visivel e observada: abrir outra troca o observador.
  taskFiles: async (id: number) => {
    const t = asTask(id), dir = taskDir(t)
    if (filesWatch?.taskId !== t.id || filesWatch.dir !== dir) { // mesma tarefa: mantem o observador (e o historico de gravacoes)
      filesWatch?.off()
      filesWatch = { taskId: t.id, dir, off: watchDir(dir, rel => emit({ fileWrite: { taskId: t.id, path: rel } })) }
    }
    return { isolated: dir !== t.game, ...(await changedFiles(dir)) }
  },
  fileDiff: (id: number, rel: string, full?: boolean) => { const t = asTask(id); return fileDiff(taskDir(t), asStr(rel, 'arquivo', 1000), full === true) },
  stopFiles: () => { filesWatch?.off(); filesWatch = null },
  // Nucleo da home: gravacoes da ultima hora (em memoria) e, por projeto, commits recentes e o que esta sem commit (pasta + worktrees).
  pulseEvents: () => pulse.events(),
  projectsPulse: () => Promise.all(listGames().map(async g => {
    const wts = (db.prepare('SELECT worktree FROM tasks WHERE game=? AND worktree IS NOT NULL').all(g) as any[]).map(r => r.worktree as string).filter(w => fs.existsSync(w))
    const dirts = (await Promise.all([g, ...wts].map(dirtOf))).filter(Boolean) as { lines: number; files: number }[]
    return { game: g, commits: await recentCommits(g, Date.now() - 3600_000), dirt: dirts.length ? { lines: dirts.reduce((n, d) => n + d.lines, 0), files: dirts.reduce((n, d) => n + d.files, 0) } : null }
  })),
  projectNames,
  getProjectGroups: () => { try { return cleanGroups(JSON.parse(getSetting('projectGroups') ?? '[]')) } catch { return [] } },
  setProjectGroups: (groups: unknown) => { setSetting('projectGroups', JSON.stringify(cleanGroups(groups))); emit({ groupsChanged: true }) },
  renameProject: (game: string, title: string) => {
    const g = asGame(game), m = projectNames(), t = asStr(title, 'nome', 80).trim()
    if (t && t !== path.basename(g)) m[g] = t; else delete m[g] // vazio ou igual a pasta: volta ao nome da pasta
    setSetting('projectNames', JSON.stringify(m))
  },
  // ---- Tarefas
  taskBriefs: (game: string) => taskBriefs(db, asGame(game)).map(b => ({ ...b, question: questions.list(b.id)[0]?.questions[0].question.slice(0, 60) ?? null })), // perguntas so em memoria
  listTasks: (game: string, o: any) => listTasks(db, asGame(game), { search: typeof o?.search === 'string' ? o.search.slice(0, 200) : undefined, archived: o?.archived === true })
    .map(t => ({ ...t, running: active.has(t.id) })),
  // Estado do projeto (tipo, Git da pasta e das worktrees) e atividade das tarefas; so leitura, sem IA.
  projectInfo: async (game: string) => {
    const g = asGame(game)
    const wt = db.prepare('SELECT id, title, worktree FROM tasks WHERE game=? AND worktree IS NOT NULL').all(g) as any[]
    const info = await projectInfo(g, dir => wt.find(t => samePath(t.worktree, dir)) ?? null)
    const act = db.prepare("SELECT MAX(updated_at) last, SUM(state<>'concluida' AND archived_at IS NULL) open FROM tasks WHERE game=?").get(g) as any
    return { ...info, lastActivity: act?.last ?? null, openTasks: act?.open ?? 0 }
  },
  // Tokens por tarefa do projeto (entrada + saida registradas pelos provedores) com a cobertura: `state` partial = total conhecido, nao o consumo
  // completo; tarefas sem registro nao aparecem e campo nao informado nunca vira zero.
  projectUsage: (game: string) => (db.prepare('SELECT DISTINCT u.task_id id FROM usage_records u JOIN tasks t ON t.id = u.task_id WHERE t.game=?').all(asGame(game)) as { id: number }[])
    .map(({ id }) => { const t = taskUsage(db, id).all.tokens; return { taskId: id, tokens: t.sum, state: t.state, estimated: t.estimated } }),
  // ---- Jarvis
  askJarvis: (question: string, todo: unknown, history: unknown, project?: unknown) => askJarvis(asStr(question, 'pergunta', 4000).trim() || fail('Pergunta vazia.'), todo, history, project == null ? undefined : asStr(project, 'pasta', 1000)),
  stopJarvis,
  getJarvisSettings: () => jarvisSettings(),
  setJarvisSettings: async (raw: any) => {
    const v: JarvisSettings = { accountId: accountRow(asInt(raw?.accountId, 'conta'))?.id ?? fail('Conta inexistente.'), model: asStr(raw?.model, 'modelo', 100), effort: asStr(raw?.effort, 'esforco', 20) }
    await checkSel({ provider: 'claude', accountId: v.accountId, model: v.model, effort: v.effort })
    setSetting('jarvis', JSON.stringify(v))
    return jarvisSettings()
  },
  // Agentes trabalhando agora (conversas e delegacoes), de todos os projetos: alimenta o dock e a barra lateral.
  listActive: () => {
    const get = db.prepare('SELECT id, game, title FROM tasks WHERE id=?')
    const runs = [...active].map(([id, r]) => ({ kind: 'chat', ...(get.get(id) as any), taskId: id, provider: r.provider, model: r.model ?? null, startedAt: r.startedAt, doing: r.doing }))
    const dels = (db.prepare("SELECT d.id, d.task_id taskId, d.provider, d.model, d.objective, d.started_at, t.game, t.title FROM delegations d JOIN tasks t ON t.id=d.task_id WHERE d.status='running'").all() as any[])
      .map(d => ({ kind: 'delegation', id: d.id, taskId: d.taskId, game: d.game, title: d.objective || d.title, provider: d.provider, model: d.model, startedAt: Date.parse(d.started_at.replace(' ', 'T') + 'Z'), doing: childDoing.get(d.id) }))
    return [...runs, ...dels]
  },
  // Arquivos enviados pelo agente (send_user_file): so copias dentro da pasta de envios da tarefa. Abrir so tipos que nao executam.
  sharedFile: (taskId: number, p: string) => sharedInfo(asStr(p, 'caminho', 2000), sentDir(asTask(taskId).id)),
  openSharedFile: async (taskId: number, p: string, reveal: unknown) => {
    const real = sharedPath(asStr(p, 'caminho', 2000), sentDir(asTask(taskId).id)) ?? fail('Arquivo enviado nao encontrado.')
    if (reveal === true) return shell.showItemInFolder(real)
    if (!canOpen(real)) fail('Este tipo de arquivo so pode ser mostrado na pasta.')
    const e = await shell.openPath(real); if (e) fail(e)
  },
  // Pai em curso e filhos chamados nesta execucao (painel do chat).
  taskAgents: (id: number) => { const t = asTask(id), r = active.get(t.id); return taskAgents(db, t.id, r, childDoing) },
  createTask: (game: string, title?: string) => createTask(db, asGame(game), title == null ? undefined : asStr(title, 'titulo', 200)),
  taskForPin: (pinId: number) => taskForPin(db, asPin(pinId)),
  renameTask: (id: number, title: string) => renameTask(db, asTask(id).id, asStr(title, 'titulo', 200)),
  // Exclusao definitiva (a interface confirma antes). Nao apaga arquivos nem worktrees do disco.
  deleteTask: (id: number) => {
    const t = asTask(id)
    if (active.has(t.id) || commands.hasTask(t.id) || (handlers.listActive() as any[]).some(a => a.taskId === t.id)) fail('Pare a execucao antes de excluir.')
    deleteTask(db, t.id)
    emit({ todoChanged: true, productionChanged: true, game: t.game })
  },
  archiveTask: (id: number, archived: boolean) => {
    const t = asTask(id)
    if (active.has(t.id)) fail('Pare a execucao antes de arquivar.')
    setArchived(db, t.id, archived === true)
  },
  setTaskState: (id: number, state: string) => setTaskState(db, asTask(id).id, TASK_STATES.includes(state) ? state : fail('Estado invalido.')),
  taskChat: (id: number, sel: any) => taskChat(asTask(id).id, asSel(sel)),
  sendTask: async (id: number, sel: any, text: string, images?: unknown, stepId?: unknown) => {
    const t = asTask(id), auto = automations.beforeSend(asSel(sel)), s = auto.sel
    for (const n of auto.notes) note(t.id, n)
    const input = attachImages(path.join(attachRoot, String(t.id)), asStr(text, 'mensagem', 200_000).trim(), images) || fail('mensagem vazia')
    reconcileSteps(db)
    const step = stepId == null ? null : asInt(stepId, 'etapa')
    if (activeStep(db, t.id)) fail('Aguarde ou cancele a etapa atual antes de enviar outra mensagem.')
    if (step) { if (active.has(t.id)) fail('O agente ainda está respondendo.'); beginStep(db, t.id, step) }
    // Checkpoint do turno: congela o Git da pasta antes do agente mexer; best-effort (pasta sem Git ou com
    // operacao pendente so fica sem checkpoint) e nunca impede o envio.
    let turnCheckpoint: { id: number } | null = null
    try { turnCheckpoint = await takeCheckpoint(db, await taskCwd(t), t.id, {}) } catch {}
    try {
      const result = await sendTask(t.id, s, input)
      if (step) bindStep(db, step, result)
      if (turnCheckpoint && result.status === 'started' && 'runId' in result && result.runId)
        db.prepare('UPDATE task_checkpoints SET run_id=? WHERE id=?').run(result.runId, turnCheckpoint.id)
      return result
    }
    catch (e) { if (step) failStep(db, step, String((e as Error).message)); throw e }
    finally { emit({ taskId: t.id, refresh: true }) }
  },
  stopTask: (id: number) => active.get(asInt(id, 'tarefa'))?.cancel(),
  isolateTask: (id: number) => backups.exclusive(() => isolateTask(asTask(id).id), true),
  newSession: (id: number, sel: any) => {
    const t = asTask(id), s = asSel(sel)
    if (active.has(t.id)) fail('Pare a execucao antes de abrir uma nova sessao.')
    if (resetSession(db, t.id, s.provider, profileOf(s.provider, s.accountId)))
      note(t.id, `Nova sessao de ${s.provider}: a proxima mensagem comeca com contexto vazio. O historico recente so segue se voce aprovar o pacote.`)
    return true
  },
  launchTask: (id: number, sel: any, o: any) => o?.isolate === true ? backups.exclusive(() => launchTask(asTask(id).id, asSel(sel), o?.resume === true, true), true) : launchTask(asTask(id).id, asSel(sel), o?.resume === true, false),
  // Catalogo de modelos/esforcos do provedor (fonte nativa quando existe) e escolha persistida da tarefa.
  delegationReport: () => delegationReport(db, 7),
  // Avisos (Configuracoes > Avisos). O teste mostra um exemplo fixo mesmo com a janela em foco, sem executar nada.
  getNotifySettings: () => notifyPrefs(),
  setNotifySettings: (raw: unknown) => { const n = normalizeNotify(raw); setSetting('notifications', JSON.stringify(n)); return n },
  testNotice: (group: unknown) => {
    const base = { taskId: -1, game: '', project: 'Meu jogo', step: null, files: null, filesTotal: null, activity: null, command: null, model: null }
    const done = { ...base, kind: 'done' as const, heading: 'Terminou', title: 'Exemplo: corrigir pulo duplo', provider: 'claude', model: 'opus', duration: '3 min', summaryFrom: 'agent' as const,
      summary: 'Ajustei o coyote time para 0,12 s e bloqueei o segundo pulo enquanto o personagem está no ar. O teste de pulo passou.',
      files: [{ path: 'scripts/player.gd', added: 30, removed: 5, isNew: false }, { path: 'tests/test_jump.gd', added: 12, removed: 0, isNew: true }, { path: 'scenes/hud.tscn', added: 2, removed: 2, isNew: false }],
      filesTotal: { count: 3, added: 44, removed: 7 }, activity: { tools: 14, commands: 3, tests: 2, passed: 1, failed: 1, lastOk: true, summary: '12 testes, 12 passaram, 0 falharam' } }
    showNotice(done, notifyPrefs(), true)
    if (group === true) {
      showNotice({ ...base, kind: 'cmd-fail', heading: 'Build falhou', title: 'Exemplo: exportar demo', provider: null, duration: '48 s', summaryFrom: 'app',
        summary: 'ERRO: falta a textura res://art/hero.png', command: { name: 'Exportar Windows', exitCode: 1 } }, notifyPrefs(), true)
      showNotice({ ...base, kind: 'review', heading: 'Etapa pronta para revisão', title: 'Exemplo: menu de pausa', provider: 'codex', duration: '7 min', summaryFrom: 'agent', step: 'Implementar menu',
        summary: 'Menu de pausa com continuar, opções e sair.', filesTotal: { count: 2, added: 80, removed: 0 } }, notifyPrefs(), true)
    }
  },
  // Janela de aviso: lista atual, tamanho do conteudo, fechar e abrir (abrir so traz a Orbita e mostra a tarefa; nada e executado).
  noticeList: () => pendingNotices,
  planetUsage: usageForPlanet,
  planetMoons: () => moons(db),
  planetOpen: () => { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus() },
  planetState,
  summaryTitles,
  setSummaryTitles: (on: unknown) => { setSetting('summaryTitles', on === false ? 'off' : 'on'); return summaryTitles() },
  setPlanet: (on: unknown) => { setSetting('planet', on === false ? 'off' : 'on'); fitNotices(0); toPopup({ planet: planetState() }); return planetState() },
  // Arrastar: a janela segue o ponteiro; ao soltar, a posicao vai para dentro da tela mais proxima e fica salva.
  planetDrag: (x: unknown, y: unknown) => {
    if (!noticeWin || noticeWin.isDestroyed() || pendingNotices.length || !Number.isFinite(x) || !Number.isFinite(y)) return
    noticeWin.setBounds({ x: Math.round(x as number), y: Math.round(y as number), width: PLANET, height: PLANET })
  },
  planetDrop: () => {
    if (!noticeWin || noticeWin.isDestroyed() || pendingNotices.length) return
    const { x, y } = noticeWin.getBounds()
    const wa = screen.getDisplayNearestPoint({ x: x + PLANET / 2, y: y + PLANET / 2 }).workArea
    setSetting('planetPos', JSON.stringify({ x: Math.min(Math.max(x, wa.x), wa.x + wa.width - PLANET), y: Math.min(Math.max(y, wa.y), wa.y + wa.height - PLANET) }))
    fitNotices(0)
    toPopup({ planet: planetState() })
  },
  noticeFit: (h: unknown) => fitNotices(Number(h) || 0),
  noticeDismiss: (key: unknown) => { const i = pendingNotices.findIndex(n => n.key === key); if (i >= 0) pendingNotices.splice(i, 1) },
  noticeOpen: (key: unknown, files: unknown) => {
    const i = pendingNotices.findIndex(n => n.key === key)
    const n = i >= 0 ? pendingNotices.splice(i, 1)[0] : null
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show(); win.focus()
    if (n && n.taskId > 0) send({ openTask: { game: n.game, taskId: n.taskId, files: files === true } })
  },
  getDelegationSettings: () => ({ ...delegationSettings(), providers: Object.keys(AGENTS), mcpProviders: ['claude', 'codex', 'opencode'] }),
  setDelegationSettings: (raw: any) => {
    const n = normalizeSettings({ ...DEFAULT_SETTINGS, ...raw })
    setSetting('delegation', JSON.stringify(n))
    return n
  },
  // Agentes nomeados para delegacao ("Fabricio" = codex / gpt-6-luna). Salvar valida nome unico e provedor/modelo no catalogo; os agentes
  // veem o catalogo na descricao da ferramenta de delegacao a partir da proxima execucao. Modelos para o dropdown: IPC `catalog`.
  getAgentAliases: () => agentAliases(),
  setAgentAliases: async (list: unknown) => {
    const v = await validateAliases(list, delegationDeps.catalogCheck)
    setSetting('agentAliases', JSON.stringify(v))
    return v
  },
  listDelegations: (taskId: number) => db.prepare('SELECT id, provider, model, effort, mode, objective, status, error, changed_files, out_of_scope, consumed, artifact_id, package_id, continuation_of, started_at, ended_at FROM delegations WHERE task_id=? ORDER BY id DESC LIMIT 50').all(asTask(taskId).id),
  ...contextHandlers({ db, asTask, asGame, taskCwd, emit, decideSend, contextLimits, waiters, broker, permissionSettings, setSetting, attachRoot }),
  // ---- Perguntas do agente (ask_user) e sugestoes de tarefa (suggest_task). Usar a sugestao so cria a tarefa: a ordem volta ao compositor.
  listQuestions: (taskId?: number) => questions.list(taskId == null ? undefined : asTask(taskId).id),
  answerQuestion: (id: number, answers: unknown) => questions.answer(asInt(id, 'pergunta'), answers ?? null),
  listSuggestions: (taskId: number) => listSuggestions(db, asTask(taskId).id),
  dismissSuggestion: (id: number) => dismissSuggestion(db, asInt(id, 'sugestao')),
  startSuggestion: (id: number) => startSuggestion(db, asInt(id, 'sugestao')),
  getAutomations: () => automations.rules(),
  setAutomations: (raw: unknown) => automations.setRules(raw),
  getHandover: () => handoverSettings(),
  setHandover: (raw: unknown) => { const n = normalizeHandover(raw); setSetting('handover', JSON.stringify(n)); return n },
  getContextLimits: () => storedLimits(),
  setContextLimits: (raw: any) => {
    const n = normalizeLimits(raw)
    setSetting('contextLimits', JSON.stringify(n))
    return n
  },
  catalog: (provider: string, force?: boolean) => {
    const s = asSel({ provider })
    return getCatalog(s.provider, envFor(s), force === true)
  },
  setTaskSel: async (id: number, sel: any) => {
    const t = asTask(id), s = asSel(sel)
    await checkSel(s)
    saveSel(db, t.id, s)
  },
  launchGame: async (game: string, sel: any) => {
    const s = asSel(sel)
    await worktrees.assertAvailable(asGame(game))
    openTerminal(asGame(game), `${s.provider} - ${path.basename(asGame(game))}`, AGENTS[s.provider].cmd, envFor(s))
  },
  ...branchHandlers({ db, listGames, worktrees, openExternal: url => shell.openExternal(url) }),
  // Checkpoints do turno: a pasta da tarefa congela sozinha antes de cada mensagem; aqui o usuario cria, lista e volta.
  listCheckpoints: (taskId: number) => listCheckpoints(db, asTask(taskId).id),
  createCheckpoint: async (taskId: number) => {
    const t = asTask(taskId), dir = await taskCwd(t) // taskCwd ja confere assertAvailable(dir)
    const cp = await takeCheckpoint(db, dir, t.id, {})
    note(t.id, `Checkpoint criado (${cp.head?.slice(0, 7) ?? 'pasta limpa sem commits'}): a pasta pode voltar a este ponto.`)
    emit({ taskId: t.id, refresh: true })
    return cp
  },
  previewCheckpointRewind: async (taskId: number, id: number) => previewRewind(db, await taskCwd(asTask(taskId)), asTask(taskId).id, asInt(id, 'checkpoint')),
  rewindCheckpoint: async (taskId: number, id: number, token: string) => {
    const t = asTask(taskId), dir = await taskCwd(t)
    if (active.has(t.id)) fail('Pare a execução desta tarefa antes de voltar.')
    if (commands.busy(dir)) fail('Aguarde ou cancele o comando local nesta pasta antes de voltar.')
    const r = await rewindCheckpoint(db, dir, t.id, asInt(id, 'checkpoint'), asStr(token, 'prévia', 200))
    note(t.id, `Pasta voltada ao checkpoint #${asInt(id, 'checkpoint')} (${r.head.slice(0, 7)}). Mudanças posteriores foram descartadas.`)
    emit({ taskId: t.id, refresh: true })
    return r
  },
  // Nova: o que espera voce (pergunta/permissao/contexto pendente) e o que foi concluido hoje, por pasta. So leitura, sem IA.
  novaState: () => {
    const gs = new Set(listGames().map(g => g.toLowerCase()))
    const waiting = (db.prepare(`SELECT t.id, t.game, t.title,
        (SELECT summary FROM permission_requests p WHERE p.task_id=t.id AND p.state='pending' ORDER BY p.id LIMIT 1) perm
      FROM tasks t WHERE t.archived_at IS NULL AND (
        EXISTS (SELECT 1 FROM permission_requests p WHERE p.task_id=t.id AND p.state='pending') OR
        EXISTS (SELECT 1 FROM context_packages c WHERE c.task_id=t.id AND c.state='pending'))`).all() as any[])
      .filter(r => gs.has(String(r.game).toLowerCase())).map(r => ({ id: r.id, game: r.game, title: r.title, why: r.perm ? `Permitir: ${String(r.perm).slice(0, 60)}` : 'Aprovar contexto' }))
    for (const q of questions.list()) { // perguntas ficam em memoria (questions.ts): uma linha por tarefa, e a pergunta vem primeiro
      const t = getTask(db, q.taskId), why = `Responder: ${q.questions[0].question.slice(0, 60)}`
      if (!t || t.archived_at || !gs.has(t.game.toLowerCase())) continue
      const w = waiting.find(x => x.id === t.id)
      if (!w) waiting.unshift({ id: t.id, game: t.game, title: t.title, why })
      else if (!w.why.startsWith('Responder')) w.why = why
    }
    const done = db.prepare("SELECT game, COUNT(*) n FROM tasks WHERE state='concluida' AND date(updated_at, 'localtime')=date('now', 'localtime') GROUP BY game").all() as any[]
    return { waiting, doneToday: Object.fromEntries(done.filter(r => gs.has(String(r.game).toLowerCase())).map(r => [r.game, r.n])) }
  },
  // So pastas de projetos listados ou worktrees de problemas/tarefas registrados.
  openFolder: (p: string) => {
    const worktrees = [
      ...(db.prepare('SELECT worktree FROM pins WHERE worktree IS NOT NULL').all() as any[]),
      ...(db.prepare('SELECT worktree FROM tasks WHERE worktree IS NOT NULL').all() as any[])
    ].map(r => r.worktree)
    return shell.openPath(asAllowedPath([...listGames(), ...worktrees], p, 'pasta'))
  },
  // Uma unica conversa fixa (criada na primeira visita) + o que esta na mesa do agente.
  linkedin: () => {
    fs.mkdirSync(linkedinDir, { recursive: true })
    const row = db.prepare('SELECT id FROM tasks WHERE game=? AND archived_at IS NULL ORDER BY id LIMIT 1').get(linkedinDir) as any
    return { dir: linkedinDir, taskId: row?.id ?? createTask(db, linkedinDir, 'LinkedIn'), desk: readDesk(linkedinDir) }
  },
  linkedinPublished: (name: string) => markPublished(linkedinDir, name),
  linkedinAuth: liStatus,
  linkedinConnect: liConnect,
  linkedinCancelConnect: cancelConnect,
  linkedinDisconnect: () => { db.prepare("DELETE FROM settings WHERE key='linkedinAuth'").run(); return liStatus() },
  linkedinPost: liPost,
  openUrl: (u: string) => { if (/^https:\/\/www\.linkedin\.com\//.test(asStr(u, 'endereco', 500))) shell.openExternal(u) },
  linkedinOpen: (sub: string) => {
    const dir = path.join(linkedinDir, ['videos', 'rascunhos'].includes(sub) ? sub : '')
    fs.mkdirSync(dir, { recursive: true })
    return shell.openPath(dir)
  }
}

const rendererUrl = process.env.ELECTRON_RENDERER_URL
const rendererFile = path.join(__dirname, '../renderer/index.html')
// So o nosso proprio renderer pode chamar a ponte IPC.
const trusted = (e: IpcMainInvokeEvent) => {
  const url = e.senderFrame?.url ?? ''
  return rendererUrl ? url.startsWith(rendererUrl) : url.startsWith(pathToFileURL(path.dirname(rendererFile)).href)
}
returnReads(handlers) // setters devolvem o formato da leitura (o renderer o guarda como cache)
for (const [name, fn] of Object.entries(handlers))
  ipcMain.handle(name, (e, ...args) => (trusted(e) ? backups.invoke(() => fn(...args)) : fail('Origem nao permitida.')))

// Pulso: a cada 3 s as pastas com agente trabalhando entram no observador; as que terminaram saem (os eventos ficam por 1 h).
setInterval(() => {
  try {
    const dirs = new Map<string, { dir: string; game: string; provider: string | null }>()
    for (const a of handlers.listActive() as any[]) {
      const t = getTask(db, a.taskId)
      if (t && !dirs.has(taskDir(t))) dirs.set(taskDir(t), { dir: taskDir(t), game: t.game, provider: a.provider })
    }
    pulse.track([...dirs.values()])
  } catch {}
}, 3000)

// Links do Markdown abrem no navegador do sistema (so http/https/mailto); a janela nunca navega para fora.
const openExternal = (url: string) => {
  try { if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) shell.openExternal(url) } catch {}
}

// Mesmo ID do atalho da area de trabalho: a janela aberta agrupa com o icone fixado na barra de tarefas.
app.setAppUserModelId('gaming-planning-dashboard')

app.whenReady().then(() => {
  // Sem barra de titulo nem menu: a barra superior do app vira a area de arrastar e os botoes do Windows ficam sobrepostos a ela.
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({
    width: 1400, height: 900, title: 'Órbita', icon: path.join(__dirname, '../../resources/icon.png'), show: false, backgroundColor: '#0c0f15',
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#0c0f15', symbolColor: '#8c96a8', height: 52 },
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  // GPD_DISPLAY=2 abre no segundo monitor (os testes e2e usam para nao ocupar a tela principal).
  const display = screen.getAllDisplays()[Number(process.env.GPD_DISPLAY) - 1]
  if (display) win.setBounds(display.workArea)
  win.on('closed', () => { if (noticeWin && !noticeWin.isDestroyed()) noticeWin.destroy() }) // a janela de aviso escondida seguraria o processo vivo e o atalho abriria so um fantasma
  win.on('focus', () => { if (!win || win.isDestroyed()) return; win.flashFrame(false); noticesToApp() })
  win.once('ready-to-show', () => { win!.maximize(); win!.show() })
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win!.webContents.getURL()) { e.preventDefault(); openExternal(url) }
  })
  if (rendererUrl) win.loadURL(rendererUrl)
  else win.loadFile(rendererFile)
  noticeWindow()
})
app.on('window-all-closed', () => app.quit())

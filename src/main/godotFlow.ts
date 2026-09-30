// Receitas locais explícitas: revalidar antes de executar e preservar a origem de cada exportação.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeCommand, projectCommands, saveCommands, type ProjectCommand } from './commands.ts'
import { godotCommand, godotDiagnostics, godotOrganizer, type GodotAction, type GodotArgs } from './godot.ts'
import { inside, samePath, safeJoin } from './guard.ts'

type Probe = { executable: string; version: string; major: number; capabilities: string[] }
type BinaryIdentity = { path: string; size: number; mtime: number; dev: number; ino: number; birthtime: number }
type Plan = { organizerId: string; configExecutable: string; workspace: string; action: GodotAction; args: GodotArgs; command: ProjectCommand; executableIdentity: BinaryIdentity; version: string }
const canonical = (p: string) => fs.realpathSync.native(p).toLowerCase()
const planKey = (game: string, name: string) => `godotPlan:${canonical(game)}:${name}`
const exportKey = (game: string, cwd: string, command: ProjectCommand) => 'godotExportPlan:' + crypto.createHash('sha256').update(JSON.stringify([canonical(game), canonical(cwd), command])).digest('hex')
const sameCommand = (a: ProjectCommand, b: ProjectCommand) => a.name === b.name && a.purpose === b.purpose && a.program === b.program && JSON.stringify(a.args) === JSON.stringify(b.args)
function binaryIdentity(executable: string): BinaryIdentity {
  const real = fs.realpathSync.native(executable), s = fs.statSync(real)
  if (!s.isFile()) throw Error('Executável Godot não é um arquivo.')
  return { path: real, size: s.size, mtime: s.mtimeMs, dev: s.dev, ino: s.ino, birthtime: s.birthtimeMs }
}
function readPlan(db: DatabaseSync, key: string): Plan | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
  if (!row) return undefined
  try { return JSON.parse(row.value) } catch { throw Error('Receita Godot inválida. Prepare o comando novamente.') }
}
function savePlan(db: DatabaseSync, key: string, plan: Plan) { db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(plan)) }
function actionArgs(action: unknown, raw: unknown): { action: GodotAction; args: GodotArgs } {
  if (typeof action !== 'string' || !['import', 'check', 'run', 'editor', 'export'].includes(action)) throw Error('Ação Godot inválida.')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Opções Godot inválidas.')
  const args: GodotArgs = {}, strings = ['script', 'scene', 'preset', 'output', 'log'], booleans = ['debug', 'headless']
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined && [...strings, ...booleans].includes(key)) continue
    if (strings.includes(key) && typeof value === 'string' && value.length <= 2000 && !/[\0\r\n]/.test(value)) (args as Record<string, unknown>)[key] = value
    else if (booleans.includes(key) && typeof value === 'boolean') (args as Record<string, unknown>)[key] = value
    else throw Error('Opções Godot inválidas.')
  }
  return { action: action as GodotAction, args }
}

export function prepareGodot(db: DatabaseSync, game: string, cwd: string, action: unknown, args: unknown, probe: Probe): ProjectCommand {
  const organizer = godotOrganizer(db, game)
  if (!organizer) throw Error('Ative Godot no organizador deste projeto.')
  const a = actionArgs(action, args)
  if (probe.major !== 4 || !/^4\.\d+/.test(probe.version) || !path.isAbsolute(probe.executable)) throw Error('Confira o executável Godot 4 antes de preparar o comando.')
  if (path.isAbsolute(organizer.config.executable) && !samePath(organizer.config.executable, probe.executable)) throw Error('O executável configurado mudou. Prepare novamente.')
  const executableIdentity = binaryIdentity(probe.executable), command = godotCommand(cwd, probe.executable, a.action, a.args)
  if (command.args.some(flag => flag.startsWith('--') && !probe.capabilities.includes(flag))) throw Error('O binário Godot não oferece os recursos necessários para este comando.')
  const plan: Plan = { organizerId: organizer.id, configExecutable: organizer.config.executable, workspace: fs.realpathSync.native(cwd), ...a, command, executableIdentity, version: probe.version }
  const current = projectCommands(db, game), previous = current.find(c => c.name.toLowerCase() === command.name.toLowerCase())
  const previousPlan = previous && readPlan(db, planKey(game, previous.name))
  if (previous && (!previousPlan || !sameCommand(previous, previousPlan.command))) throw Error('Existe um comando manual com este nome. Renomeie-o antes de preparar Godot.')
  db.exec('SAVEPOINT godot_prepare')
  try {
    saveCommands(db, game, previous ? current.map(c => c === previous ? command : c) : [...current, command])
    savePlan(db, planKey(game, command.name), plan)
    if (a.action === 'export') savePlan(db, exportKey(game, cwd, command), plan)
    db.exec('RELEASE godot_prepare')
  } catch (e) { db.exec('ROLLBACK TO godot_prepare'); db.exec('RELEASE godot_prepare'); throw e }
  return command
}

export function validatePreparedGodot(db: DatabaseSync, game: string, cwd: string, command: ProjectCommand): void {
  if (!command.name.startsWith('Godot · ')) return
  const plan = readPlan(db, planKey(game, command.name)), organizer = godotOrganizer(db, game)
  if (!plan || !organizer || organizer.id !== plan.organizerId || organizer.config.executable !== plan.configExecutable || !sameCommand(command, plan.command)) throw Error('Receita/configuração Godot mudou. Prepare o comando novamente no organizador ativo.')
  if (typeof plan.workspace !== 'string' || !samePath(cwd, plan.workspace)) throw Error('A pasta preparada para Godot mudou. Prepare o comando novamente na pasta atual.')
  if (JSON.stringify(binaryIdentity(command.program)) !== JSON.stringify(plan.executableIdentity)) throw Error('O executável Godot mudou. Confira e prepare novamente.')
  const current = godotCommand(cwd, command.program, plan.action, plan.args)
  if (!sameCommand(current, command)) throw Error('Os caminhos do comando Godot mudaram. Prepare novamente nesta pasta.')
}

export function godotCommandError(command: ProjectCommand, output: string, truncated: boolean): string | undefined {
  if (!command.name.startsWith('Godot · ')) return undefined
  const errors = godotDiagnostics(output).errorCount
  if (errors) return `Godot informou ${errors} erro(s); consulte os diagnósticos. Exit 0 não comprova qualidade.`
  if (truncated) return 'Saída Godot truncada: não foi possível confirmar ausência de erros. Consulte o log completo e execute novamente.'
  return undefined
}

export function godotBuildFile(db: DatabaseSync, taskId: number, commandId: number, cwd: string): string {
  const task = db.prepare('SELECT game,worktree FROM tasks WHERE id=?').get(taskId) as { game: string; worktree: string | null } | undefined
  const run = db.prepare("SELECT * FROM command_runs WHERE id=? AND task_id=? AND status='completed' AND exit_code=0 AND error IS NULL AND truncated=0").get(commandId, taskId) as { workspace: string; name: string; program: string; args: string; output: string } | undefined
  if (!task || !run || !samePath(run.workspace, cwd) || !samePath(task.worktree || task.game, cwd) || (!samePath(task.game, cwd) && !inside(path.join(fs.realpathSync(task.game), '.worktrees'), fs.realpathSync(cwd)))) throw Error('Selecione uma exportação Godot concluída nesta tarefa e pasta.')
  let command: ProjectCommand
  try { command = normalizeCommand({ name: run.name, purpose: 'build', program: run.program, args: JSON.parse(run.args) }) } catch { throw Error('Registro da exportação Godot inválido.') }
  const plan = readPlan(db, exportKey(task.game, cwd, command))
  if (!plan || plan.action !== 'export' || !sameCommand(plan.command, command) || command.name !== 'Godot · Exportar build' || godotCommandError(command, run.output, false)) throw Error('Comando sem receita de exportação Godot verificada.')
  const a = command.args
  if (![6, 8].includes(a.length) || a[0] !== '--headless' || a[1] !== '--path' || a[2] !== '.' || !['--export-release', '--export-debug'].includes(a[3]) || a[4] !== plan.args.preset || (a.length === 8 && a[6] !== '--log-file')) throw Error('Argumentos da exportação Godot inválidos.')
  const output = a[5]
  if (!output || !/\.exe$/i.test(output) || path.isAbsolute(output) || /^[a-z]:/i.test(output) || output.split(/[\\/]/).some(p => ['..', '.git', '.godot', '.import', '.worktrees'].includes(p))) throw Error('Saída da exportação Godot inválida.')
  const file = safeJoin(cwd, output), dir = path.dirname(file)
  if (fs.lstatSync(path.resolve(cwd, output)).isSymbolicLink() || !fs.statSync(file).isFile() || !fs.statSync(file).size) throw Error('Arquivo exportado não encontrado, vazio ou substituído por link.')
  const allowed = new Set([path.basename(file)])
  if (a.length === 8) { const log = safeJoin(cwd, a[7]); if (samePath(path.dirname(log), dir)) allowed.add(path.basename(log)) }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (!entry.isFile() || entry.isSymbolicLink() || !allowed.has(entry.name)) throw Error('Exportação possui arquivos auxiliares; o catálogo não pode registrar este .exe como build completo.')
  return path.relative(fs.realpathSync(cwd), file).split(path.sep).join('/')
}

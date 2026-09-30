// Receitas locais preparadas para Unity/Blender (Godot tem godotFlow): o humano revisa o comando exato, e o backend revalida
// organizador, executável configurado, identidade do binário, pasta, argumentos recalculados e scripts fixados antes do spawn.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { projectCommands, saveCommands, type ProjectCommand } from './commands.ts'
import { ENGINE_LABELS, engineOrganizer } from './engines.ts'
import { samePath, safeJoin } from './guard.ts'
import { BLENDER_RECIPE } from './blenderFlow.ts'
import { UNITY_RECIPE } from './unityFlow.ts'

export const FLOW_ENGINES = ['unity', 'blender'] as const
export type FlowEngine = typeof FLOW_ENGINES[number]
export type EngineProbe = { exe: string; version: string }
export type EngineDiagnostic = { severity: 'error' | 'warning' | 'info'; message: string; file?: string; line?: number; count: number }
export type EngineReview = { file: string; text: string; truncated: boolean }
// O que cada engine fornece ao fluxo. build valida e monta o comando (nome "<Engine> · ..."); pins são arquivos relativos
// cujo conteúdo fica fixado até a execução; outputs são arquivos que a execução precisa produzir. diagnostics recebe o comando e a
// pasta da execução quando a engine grava o log em arquivo (Unity -logFile); verdict reprova antes dos erros genéricos (ex.: testes).
export type EngineRecipe = {
  actions: readonly string[]
  fields: Record<string, 'string' | 'integer' | 'boolean'>
  probe: (executable: string, cwd: string) => Promise<EngineProbe>
  build: (cwd: string, exe: string, action: string, args: Record<string, unknown>) => { command: ProjectCommand; pins: string[] }
  outputs: (command: ProjectCommand) => string[]
  diagnostics: (output: string, run?: { command: ProjectCommand; cwd: string }) => { items: EngineDiagnostic[]; errorCount: number; warningCount: number; totalLines: number }
  verdict?: (command: ProjectCommand, cwd: string) => string | undefined
  details: (cwd: string) => Promise<unknown>
}
const RECIPES: Partial<Record<FlowEngine, EngineRecipe>> = { unity: UNITY_RECIPE, blender: BLENDER_RECIPE }

type BinaryIdentity = { path: string; size: number; mtime: number; dev: number; ino: number; birthtime: number }
type Plan = { engine: FlowEngine; organizerId: string; configExecutable: string; workspace: string; action: string; args: Record<string, unknown>; command: ProjectCommand; executableIdentity: BinaryIdentity; version: string; pins: Record<string, string> }
const prefix = (engine: FlowEngine) => `${ENGINE_LABELS[engine]} · `
const planKey = (engine: FlowEngine, game: string, name: string) => `enginePlan:${engine}:${fs.realpathSync.native(game).toLowerCase()}:${name}`
const sameCommand = (a: ProjectCommand, b: ProjectCommand) => a.name === b.name && a.purpose === b.purpose && a.program === b.program && JSON.stringify(a.args) === JSON.stringify(b.args)
const hash = (cwd: string, rel: string) => crypto.createHash('sha256').update(fs.readFileSync(safeJoin(cwd, rel))).digest('hex')
const pinsOf = (cwd: string, rels: string[]) => Object.fromEntries(rels.map(r => [r, hash(cwd, r)]))

export function flowEngine(engine: unknown): FlowEngine {
  if (!FLOW_ENGINES.includes(engine as FlowEngine)) throw Error('Engine inválida.')
  return engine as FlowEngine
}
export function engineRecipe(engine: unknown): EngineRecipe {
  const e = flowEngine(engine)
  return RECIPES[e] ?? (() => { throw Error(`Comandos ${ENGINE_LABELS[e]} ainda não estão disponíveis.`) })()
}
const engineOfCommand = (command: ProjectCommand) => FLOW_ENGINES.find(e => command.name.startsWith(prefix(e)))

function binaryIdentity(executable: string): BinaryIdentity {
  const real = fs.realpathSync.native(executable), s = fs.statSync(real)
  if (!s.isFile()) throw Error('O executável configurado não é um arquivo.')
  return { path: real, size: s.size, mtime: s.mtimeMs, dev: s.dev, ino: s.ino, birthtime: s.birthtimeMs }
}
function readPlan(db: DatabaseSync, key: string): Plan | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
  if (!row) return undefined
  try { return JSON.parse(row.value) } catch { throw Error('Receita inválida. Prepare o comando novamente.') }
}
function actionArgs(recipe: EngineRecipe, label: string, action: unknown, raw: unknown) {
  if (typeof action !== 'string' || !recipe.actions.includes(action)) throw Error(`Ação ${label} inválida.`)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`Opções ${label} inválidas.`)
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const type = Object.hasOwn(recipe.fields, key) ? recipe.fields[key] : undefined
    if (type && value === undefined) continue
    if (type === 'string' ? typeof value === 'string' && value.length <= 2000 && !/[\0\r\n]/.test(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'boolean' && typeof value === 'boolean') args[key] = value
    else throw Error(`Opções ${label} inválidas.`)
  }
  return { action, args }
}

// Prepara e salva o comando no projeto, com a receita que o valida. Não executa nada.
export function prepareEngine(db: DatabaseSync, game: string, cwd: string, engine: unknown, action: unknown, args: unknown, probe: EngineProbe): { command: ProjectCommand; review: EngineReview[] } {
  const e = flowEngine(engine), label = ENGINE_LABELS[e], recipe = engineRecipe(e), organizer = engineOrganizer(db, game, e)
  if (!organizer) throw Error(`Ative ${label} no organizador deste projeto.`)
  const a = actionArgs(recipe, label, action, args)
  if (!probe || typeof probe.exe !== 'string' || !path.isAbsolute(probe.exe) || typeof probe.version !== 'string') throw Error(`Confira o executável ${label} antes de preparar o comando.`)
  if (path.isAbsolute(organizer.config.executable) && !samePath(organizer.config.executable, probe.exe)) throw Error('O executável configurado mudou. Prepare novamente.')
  const executableIdentity = binaryIdentity(probe.exe), { command, pins } = recipe.build(cwd, probe.exe, a.action, a.args)
  if (!command.name.startsWith(prefix(e))) throw Error(`Receita ${label} inválida.`)
  const plan: Plan = { engine: e, organizerId: organizer.id, configExecutable: organizer.config.executable, workspace: fs.realpathSync.native(cwd), ...a, command, executableIdentity, version: probe.version, pins: pinsOf(cwd, pins) }
  const current = projectCommands(db, game), previous = current.find(c => c.name.toLowerCase() === command.name.toLowerCase())
  const previousPlan = previous && readPlan(db, planKey(e, game, previous.name))
  if (previous && (!previousPlan || !sameCommand(previous, previousPlan.command))) throw Error(`Existe um comando manual com este nome. Renomeie-o antes de preparar ${label}.`)
  db.exec('SAVEPOINT engine_prepare')
  try {
    saveCommands(db, game, previous ? current.map(c => c === previous ? command : c) : [...current, command])
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(planKey(e, game, command.name), JSON.stringify(plan))
    db.exec('RELEASE engine_prepare')
  } catch (err) { db.exec('ROLLBACK TO engine_prepare'); db.exec('RELEASE engine_prepare'); throw err }
  // Conteúdo exato que será executado (ex.: script Python), para revisão humana junto ao comando.
  const review = pins.map(file => { const text = fs.readFileSync(safeJoin(cwd, file), 'utf8'); return { file, text: text.slice(0, 20_000), truncated: text.length > 20_000 } })
  return { command, review }
}

// beforeSpawn: comandos "<Engine> · ..." só executam com a receita intacta; demais comandos passam.
export function validatePreparedEngine(db: DatabaseSync, game: string, cwd: string, command: ProjectCommand): void {
  const e = engineOfCommand(command)
  if (!e) return
  const label = ENGINE_LABELS[e], plan = readPlan(db, planKey(e, game, command.name)), organizer = engineOrganizer(db, game, e)
  if (!plan || plan.engine !== e || !organizer || organizer.id !== plan.organizerId || organizer.config.executable !== plan.configExecutable || !sameCommand(command, plan.command)) throw Error(`Receita/configuração ${label} mudou. Prepare o comando novamente no organizador ativo.`)
  if (typeof plan.workspace !== 'string' || !samePath(cwd, plan.workspace)) throw Error(`A pasta preparada para ${label} mudou. Prepare o comando novamente na pasta atual.`)
  if (JSON.stringify(binaryIdentity(command.program)) !== JSON.stringify(plan.executableIdentity)) throw Error(`O executável ${label} mudou. Confira e prepare novamente.`)
  const current = engineRecipe(e).build(cwd, command.program, plan.action, plan.args)
  if (!sameCommand(current.command, command)) throw Error(`Os caminhos do comando ${label} mudaram. Prepare novamente nesta pasta.`)
  if (JSON.stringify(pinsOf(cwd, current.pins)) !== JSON.stringify(plan.pins)) throw Error(`O script revisado mudou depois da preparação. Revise e prepare o comando ${label} novamente.`)
}

// resultError: exit 0 não comprova sucesso; erros no log, saída truncada ou arquivo esperado ausente reprovam.
export function engineCommandError(command: ProjectCommand, output: string, truncated: boolean, cwd: string): string | undefined {
  const e = engineOfCommand(command), recipe = e && RECIPES[e]
  if (!e || !recipe) return undefined
  const label = ENGINE_LABELS[e], verdict = recipe.verdict?.(command, cwd)
  if (verdict) return verdict
  const errors = recipe.diagnostics(output, { command, cwd }).errorCount
  if (errors) return `${label} informou ${errors} erro(s); consulte os diagnósticos. Exit 0 não comprova o resultado.`
  if (truncated) return `Saída ${label} truncada: não foi possível confirmar ausência de erros. Consulte o log completo e execute novamente.`
  const missing = recipe.outputs(command).find(rel => { try { const f = safeJoin(cwd, rel), s = fs.lstatSync(f); return !s.isFile() || !s.size } catch { return true } })
  if (missing) return `${label} não gerou "${missing}" (ou gerou vazio); consulte os diagnósticos.`
  return undefined
}
export const isEngineCommand = (engine: FlowEngine, name: string) => name.startsWith(prefix(engine))

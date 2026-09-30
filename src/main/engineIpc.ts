// IPC das engines (Godot, Unity, Blender) por tarefa: estado, sonda, preparo de comandos, diagnosticos e build Godot.
// Cada handler revalida tarefa, pasta (taskCwd) e organizador; o comando preparado e revalidado de novo antes do spawn (commands.ts).
import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { commandRun, listCommandRuns } from './commands.ts'
import { godotDiagnostics, godotOrganizer, godotProbe, godotProject } from './godot.ts'
import { ENGINE_LABELS, engineOrganizer, engineProjectAt } from './engines.ts'
import { engineRecipe, flowEngine, isEngineCommand, prepareEngine } from './engineFlow.ts'
import { godotBuildFile, prepareGodot } from './godotFlow.ts'
import { asInt, fail, safeJoin, samePath } from './guard.ts'
import type { Task } from './tasks.ts'

export function engineHandlers(d: {
  db: DatabaseSync; asTask: (v: unknown) => Task; taskCwd: (t: Task) => Promise<string>; emit: (ev: object) => void
  productionChange: (game: unknown, change: (g: string) => unknown) => Promise<unknown>
  registerProjectBuild: (game: string, raw: any) => unknown
}) {
  const { db, asTask, taskCwd, emit, productionChange, registerProjectBuild } = d
  // Sonda o executável configurado e confirma que tarefa, pasta e organizador não mudaram durante a espera.
  async function engineProbeChecked(taskId: number, engine: unknown) {
    const e = flowEngine(engine), recipe = engineRecipe(e), t = asTask(taskId), cwd = await taskCwd(t)
    const organizer = engineOrganizer(db, t.game, e) ?? fail(`Ative ${ENGINE_LABELS[e]} no organizador deste projeto.`)
    const probe = await recipe.probe(organizer.config.executable, cwd), now = engineOrganizer(db, t.game, e)
    if (!samePath(await taskCwd(asTask(taskId)), cwd) || now?.id !== organizer.id || now.config.executable !== organizer.config.executable) fail('O destino/configuração mudou. Confira novamente.')
    return { t, cwd, probe }
  }
  return {
    godotState: async (taskId: number, details = false) => {
      const t = asTask(taskId), organizer = godotOrganizer(db, t.game)
      if (!organizer) return { organizer: null, available: false, project: null }
      const cwd = await taskCwd(t)
      try {
        if (!fs.statSync(safeJoin(cwd, 'project.godot')).isFile()) return { organizer, available: false, project: null }
        return { organizer, available: true, project: details === true ? godotProject(cwd) : null }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { organizer, available: false, project: null }; return { organizer, available: true, project: null, error: e instanceof Error ? e.message : String(e) } }
    },
    godotProbe: async (taskId: number) => {
      const t = asTask(taskId), cwd = await taskCwd(t), organizer = godotOrganizer(db, t.game) ?? fail('Ative Godot no organizador deste projeto.')
      const result = await godotProbe(organizer.config.executable, cwd)
      if (!samePath(await taskCwd(asTask(taskId)), cwd) || godotOrganizer(db, t.game)?.id !== organizer.id || godotOrganizer(db, t.game)?.config.executable !== organizer.config.executable) fail('O destino/configuração mudou. Confira novamente.')
      return result
    },
    prepareGodotCommand: async (taskId: number, action: unknown, args: unknown) => {
      const t = asTask(taskId), cwd = await taskCwd(t), organizer = godotOrganizer(db, t.game) ?? fail('Ative Godot no organizador deste projeto.')
      const probe = await godotProbe(organizer.config.executable, cwd)
      if (!samePath(await taskCwd(asTask(taskId)), cwd) || godotOrganizer(db, t.game)?.id !== organizer.id || godotOrganizer(db, t.game)?.config.executable !== organizer.config.executable) fail('O destino/configuração mudou. Prepare novamente.')
      const command = prepareGodot(db, t.game, cwd, action, args, probe)
      emit({ taskId, game: t.game, commandConfigChanged: true }); return command
    },
    godotDiagnostics: (taskId: number, commandId: unknown) => {
      const t = asTask(taskId), id = asInt(commandId, 'comando')
      if (!listCommandRuns(db, t.id).some(r => r.id === id)) fail('Comando de outra tarefa ou fora do histórico disponível.')
      const run = commandRun(db, t.id, id) ?? fail('Comando de outra tarefa ou inexistente.')
      if (!run.name.startsWith('Godot · ')) fail('Selecione um comando Godot.')
      return { run, ...godotDiagnostics(run.output) }
    },
    // Unity/Blender (engineFlow): mesmo modelo do Godot, genérico por engine.
    engineState: async (taskId: number, engine: unknown, details = false) => {
      const e = flowEngine(engine), t = asTask(taskId), organizer = engineOrganizer(db, t.game, e)
      if (!organizer) return { organizer: null, available: false, details: null }
      const cwd = await taskCwd(t)
      try {
        if (!engineProjectAt(e, cwd)) return { organizer, available: false, details: null }
        return { organizer, available: true, details: details === true ? await engineRecipe(e).details(cwd) : null }
      } catch (err) { return { organizer, available: true, details: null, error: err instanceof Error ? err.message : String(err) } }
    },
    engineProbe: async (taskId: number, engine: unknown) => (await engineProbeChecked(taskId, engine)).probe,
    prepareEngineCommand: async (taskId: number, engine: unknown, action: unknown, args: unknown) => {
      const { t, cwd, probe } = await engineProbeChecked(taskId, engine)
      const result = prepareEngine(db, t.game, cwd, engine, action, args, probe)
      emit({ taskId, game: t.game, commandConfigChanged: true }); return result
    },
    engineDiagnostics: (taskId: number, engine: unknown, commandId: unknown) => {
      const e = flowEngine(engine), t = asTask(taskId), id = asInt(commandId, 'comando')
      if (!listCommandRuns(db, t.id).some(r => r.id === id)) fail('Comando de outra tarefa ou fora do histórico disponível.')
      const run = commandRun(db, t.id, id) ?? fail('Comando de outra tarefa ou inexistente.')
      if (!isEngineCommand(e, run.name)) fail('Selecione um comando desta engine.')
      const command = { name: run.name, purpose: 'test' as const, program: run.program, args: JSON.parse(run.args) }
      return { run, ...engineRecipe(e).diagnostics(run.output, { command, cwd: run.workspace }) }
    },
    registerGodotBuild: async (taskId: number, commandId: unknown, raw: any) => {
      const t = asTask(taskId), cwd = await taskCwd(t), id = asInt(commandId, 'comando')
      return productionChange(t.game, async g => {
        const path = godotBuildFile(db, t.id, id, cwd)
        const buildId = await registerProjectBuild(g, { title: raw?.title, version: raw?.version, notes: raw?.notes, platform: 'Windows', commandId: id, path })
        return { id: buildId }
      })
    },
  }
}

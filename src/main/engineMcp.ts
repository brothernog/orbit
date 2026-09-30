// Ferramentas MCP de engine por execução: só as engines concedidas pelo organizador (e presentes na pasta) entram no anúncio e nas consultas.
import type { DatabaseSync } from 'node:sqlite'
import { BLENDER_TOOLS, callBlenderTool } from './blenderTools.ts'
import { ENGINES, engineGrants, type EngineGrants, type EngineId } from './engines.ts'
import { GODOT_TOOLS, callGodotTool } from './godotTools.ts'
import { samePath } from './guard.ts'
import type { ContextLimits } from './limits.ts'
import type { ToolDef, ToolResult } from './mcp.ts'
import type { ToolCtx } from './taskContext.ts'
import { UNITY_TOOLS, callUnityTool } from './unityTools.ts'

export const ENGINE_TOOLS: Record<EngineId, ToolDef[]> = { godot: GODOT_TOOLS, unity: UNITY_TOOLS, blender: BLENDER_TOOLS }
export const engineOf = (name: string): EngineId | undefined => ENGINES.find(e => ENGINE_TOOLS[e].some(t => t.name === name))
export const grantedTools = (grants: EngineGrants = {}) => ENGINES.flatMap(e => grants[e] ? ENGINE_TOOLS[e] : [])
export const grantedEngines = (grants: EngineGrants = {}) => ENGINES.filter(e => grants[e])

// Revalida a concessão herdada contra a tarefa, a pasta e o organizador ATUAIS: desativar a engine ou mover a pasta revoga o anúncio.
export function liveGrants(db: DatabaseSync, taskId: number, cwd: string, grants: EngineGrants = {}): EngineGrants {
  const task = db.prepare('SELECT game,worktree FROM tasks WHERE id=?').get(taskId) as { game: string; worktree: string | null } | undefined
  if (!task || !grantedEngines(grants).length || !samePath(task.worktree || task.game, cwd)) return {}
  const now = engineGrants(db, task.game, cwd), out: EngineGrants = {}
  for (const e of grantedEngines(grants)) if (now[e] === grants[e]) out[e] = grants[e]
  return out
}

export async function callEngineTool(db: DatabaseSync, lim: ContextLimits, ctx: ToolCtx, grants: EngineGrants = {}, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
  const engine = engineOf(name)
  const id = engine ? grants[engine] ?? '' : ''
  if (engine === 'godot') return callGodotTool(db, lim, ctx, id, name, args)
  if (engine === 'unity') return callUnityTool(db, lim, ctx, id, name, args)
  if (engine === 'blender') return callBlenderTool(db, lim, ctx, id, name, args, signal)
  return { text: 'Ferramenta de engine desconhecida.', isError: true }
}

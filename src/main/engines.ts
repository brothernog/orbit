// Integrações de engine por organizador (Godot, Unity, Blender): opt-in, validadas no backend e revalidadas a cada consulta MCP.
// Cada integração só vale para os projetos do organizador que a ativou e só entra na execução quando a pasta atual é daquele tipo.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeCommand } from './commands.ts'
import { samePath } from './guard.ts'

export const ENGINES = ['godot', 'unity', 'blender'] as const
export type EngineId = typeof ENGINES[number]
export type EngineConfig = { enabled: boolean; executable: string }
export type EngineOrganizer = { id: string; name: string; config: EngineConfig }
// Capacidade herdada pela execução: organizador que concedeu cada engine. Revalidada a cada anúncio e consulta.
export type EngineGrants = Partial<Record<EngineId, string>>
export const ENGINE_LABELS: Record<EngineId, string> = { godot: 'Godot', unity: 'Unity', blender: 'Blender' }
const DEFAULT_EXE: Record<EngineId, string> = { godot: 'godot', unity: 'unity', blender: 'blender' }

export function engineOrganizer(db: DatabaseSync, game: string, engine: EngineId): EngineOrganizer | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='projectGroups'").get() as { value: string } | undefined
    const groups: unknown = JSON.parse(row?.value ?? '[]')
    if (!Array.isArray(groups)) return null
    const matches = groups.filter(g => Array.isArray(g?.games) && g.games.some((p: unknown) => typeof p === 'string' && samePath(p, game)))
    if (matches.length !== 1) return null
    const g = matches[0], configured = g[engine]?.executable
    if (g[engine]?.enabled !== true || typeof configured !== 'string' || typeof g.id !== 'string' || !g.id || typeof g.name !== 'string' || groups.filter(x => x?.id === g.id).length !== 1) return null
    const executable = configured.trim() || DEFAULT_EXE[engine]
    normalizeCommand({ name: ENGINE_LABELS[engine], purpose: 'test', program: executable, args: [] })
    return { id: g.id, name: g.name, config: { enabled: true, executable } }
  } catch { return null }
}

const isFile = (p: string) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
// Pastas que nunca contêm fontes de projeto (caches, dependências, checkouts internos).
export const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'out', 'dist', 'build', 'Build', 'Builds', '.godot', '.import', 'tmp', 'temp', 'Library', 'Temp', 'Obj', 'obj', 'Logs', 'UserSettings', '__pycache__', '.venv'])

// Procura .blend sem ler conteúdo: profundidade e entradas limitadas; o resultado fica em cache curto para o anúncio de ferramentas.
const blendCache = new Map<string, { at: number; found: boolean }>()
export function hasBlendFiles(cwd: string, limit = 5000, depth = 4): boolean {
  const key = `${depth}:${limit}:${path.resolve(cwd)}`, hit = blendCache.get(key)
  if (hit && Date.now() - hit.at < 15_000) return hit.found
  let seen = 0, found = false
  const visit = (dir: string, d: number) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (found || ++seen > limit) return
      if (e.isFile() && /\.blend$/i.test(e.name)) { found = true; return }
      if (e.isDirectory() && d < depth && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) visit(path.join(dir, e.name), d + 1)
    }
  }
  visit(path.resolve(cwd), 0)
  blendCache.set(key, { at: Date.now(), found })
  if (blendCache.size > 200) blendCache.delete(blendCache.keys().next().value as string)
  return found
}

// A pasta atual é um projeto daquela engine? Só metadados de arquivo; nada é executado.
export function engineProjectAt(engine: EngineId, cwd: string): boolean {
  if (engine === 'godot') return isFile(path.join(cwd, 'project.godot'))
  if (engine === 'unity') return isFile(path.join(cwd, 'ProjectSettings', 'ProjectVersion.txt')) && isDir(path.join(cwd, 'Assets'))
  return hasBlendFiles(cwd)
}

// Engines ativas no organizador do projeto E presentes na pasta atual.
export function engineGrants(db: DatabaseSync, game: string, cwd: string): EngineGrants {
  const out: EngineGrants = {}
  for (const e of ENGINES) {
    const o = engineOrganizer(db, game, e)
    if (o && engineProjectAt(e, cwd)) out[e] = o.id
  }
  return out
}
export const sameGrants = (a: EngineGrants = {}, b: EngineGrants = {}) => ENGINES.every(e => a[e] === b[e])

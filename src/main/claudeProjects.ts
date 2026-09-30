// Pastas conhecidas pelo Claude Code (chaves de `projects` em ~/.claude.json). O arquivo pode ter varios MB (historico por
// projeto) e a lista de projetos valida cada IPC (asGame): so relemos quando tamanho ou mtime mudam. Sem dependencia de 'electron'.
import fs from 'node:fs'

let cached: { file: string; size: number; mtimeMs: number; projects: string[] } | null = null

export function claudeProjects(file: string): string[] {
  let st: fs.Stats
  try { st = fs.statSync(file) } catch { cached = null; return [] }
  if (cached && cached.file === file && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.projects
  let projects: string[]
  try { projects = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {}) } catch { cached = null; return [] } // gravacao em andamento: tenta de novo na proxima
  cached = { file, size: st.size, mtimeMs: st.mtimeMs, projects }
  return projects
}

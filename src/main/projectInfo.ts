// Estado do projeto para a home e a visao geral: tipo (jogo/app), Git da pasta principal e das worktrees.
// So leitura e sem IA: git status/worktree list e arquivos de marcacao na raiz. Sem dependencia de 'electron'.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { samePath } from './guard.ts'

export type FileChange = { path: string; status: 'M' | 'A' | 'D' | '?' }
export type GitState = { branch: string | null; upstream: string | null; ahead: number; behind: number; files: FileChange[] }
export type WorktreeInfo = GitState & { path: string; taskId: number | null; task: string | null }
export type ProjectInfo = { kind: 'game' | 'app'; stack: string; repo: boolean; git: GitState | null; worktrees: WorktreeInfo[]; error?: string }

// `git status --porcelain=v1 -b`: primeira linha "## branch...upstream [ahead N, behind M]", depois "XY caminho".
export function parseStatus(out: string): GitState {
  const lines = out.split(/\r?\n/).filter(Boolean)
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : ''
  const m = head.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/)
  const branch = !m || /^HEAD \(no branch\)/.test(head) ? null : m[1]
  const num = (k: string) => Number(m?.[3]?.match(new RegExp(`${k} (\\d+)`))?.[1] ?? 0)
  const files = lines.map(l => {
    const xy = l.slice(0, 2), p = l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')
    const status: FileChange['status'] = xy === '??' ? '?' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M'
    return { path: p, status }
  })
  return { branch, upstream: m?.[2] ?? null, ahead: num('ahead'), behind: num('behind'), files }
}

// `git worktree list --porcelain`: blocos "worktree <path>\nHEAD <sha>\nbranch refs/heads/x" separados por linha vazia.
export function parseWorktrees(out: string): { path: string; branch: string | null }[] {
  return out.split(/\r?\n\r?\n/).map(b => {
    const p = b.match(/^worktree (.+)$/m)?.[1]
    return p ? { path: path.normalize(p.trim()), branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim() ?? null } : null
  }).filter(Boolean) as { path: string; branch: string | null }[]
}

export function detectKind(dir: string): { kind: 'game' | 'app'; stack: string } {
  const has = (f: string) => fs.existsSync(path.join(dir, f))
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch {}
  if (has('project.godot')) return { kind: 'game', stack: 'Godot' }
  if (names.some(n => n.endsWith('.uproject'))) return { kind: 'game', stack: 'Unreal' }
  if (has('Assets') && has('ProjectSettings')) return { kind: 'game', stack: 'Unity' }
  if (has('package.json')) {
    let pkg: any = {}
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch {}
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.phaser || deps.pixi || deps['pixi.js'] || deps.three) return { kind: 'game', stack: deps.phaser ? 'Phaser' : deps.three ? 'Three.js' : 'PixiJS' }
    return { kind: 'app', stack: deps.electron ? 'Electron' : deps.next ? 'Next.js' : deps.react ? 'React' : deps.vue ? 'Vue' : 'Node' }
  }
  if (has('Cargo.toml')) return { kind: names.some(n => n === 'assets') ? 'game' : 'app', stack: 'Rust' }
  if (has('pyproject.toml') || has('requirements.txt')) return { kind: 'app', stack: 'Python' }
  if (names.some(n => n.endsWith('.sln') || n.endsWith('.csproj'))) return { kind: 'app', stack: '.NET' }
  return { kind: 'app', stack: 'Projeto' }
}

// `o.env` troca variaveis (ex.: indice temporario); `o.timeout` maior para rede (push, pull, fetch).
export const run = (cwd: string, args: string[], o: { env?: Record<string, string>; timeout?: number; maxBuffer?: number } = {}) => new Promise<string>((ok, fail) =>
  execFile('git', args, { cwd, encoding: 'utf8', timeout: o.timeout ?? 8000, windowsHide: true, maxBuffer: o.maxBuffer ?? 4 << 20, env: o.env ? { ...process.env, ...o.env } : undefined }, (e, out) => (e ? fail(e) : ok(out))))

const MAX_FILES = 200 // a interface mostra poucos; o total vem do tamanho da lista antes do corte

export async function projectInfo(dir: string, taskOf: (worktree: string) => { id: number; title: string } | null): Promise<ProjectInfo> {
  const kind = detectKind(dir)
  let git: GitState
  try { git = parseStatus(await run(dir, ['status', '--porcelain=v1', '-b', '--untracked-files=normal'])) } catch (e: any) {
    const noRepo = /not a git repository/i.test(String(e?.stderr ?? e?.message))
    return { ...kind, repo: false, git: null, worktrees: [], error: noRepo ? undefined : String(e?.message ?? e).slice(0, 200) }
  }
  let list: { path: string; branch: string | null }[] = []
  // Caminho real: nome curto 8.3 (Windows) ou symlink nao duplica a pasta principal.
  try { list = parseWorktrees(await run(dir, ['worktree', 'list', '--porcelain'])).filter(w => fs.existsSync(w.path) && !samePath(w.path, dir)) } catch {}
  const worktrees = await Promise.all(list.map(async w => {
    let st: GitState = { branch: w.branch, upstream: null, ahead: 0, behind: 0, files: [] }
    try { st = parseStatus(await run(w.path, ['status', '--porcelain=v1', '-b'])) } catch {}
    const t = taskOf(w.path)
    return { ...st, files: st.files.slice(0, MAX_FILES), path: w.path, taskId: t?.id ?? null, task: t?.title ?? null }
  }))
  return { ...kind, repo: true, git: { ...git, files: git.files.slice(0, MAX_FILES) }, worktrees }
}

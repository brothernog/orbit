// Arquivos alterados na pasta de trabalho de uma tarefa, ao vivo e sem IA: fs.watch recursivo diz QUANDO algo foi gravado,
// o git diz QUANTO mudou. Sem dependencia de 'electron'; nada aqui chama provedor nem gasta token.
import fs from 'node:fs'
import path from 'node:path'
import { parseStatus, run, type FileChange } from './projectInfo.ts'

export type ChangedFile = FileChange & { added: number | null; removed: number | null; lastWrite: number | null }

const SKIP = /(^|\/)(\.git|node_modules|\.godot|\.import|\.worktrees|out|dist|build|tmp|temp|__pycache__|\.venv)(\/|$)/
export const ignored = (rel: string) => SKIP.test(rel)
const norm = (p: string) => p.replace(/\\/g, '/')
const MAX = 200

// `git diff --numstat HEAD`: "adicionadas<TAB>removidas<TAB>caminho"; binario vem "-" (vira null, nunca 0). Renomeio: fica o nome novo.
export function parseNumstat(out: string) {
  const m = new Map<string, { added: number | null; removed: number | null }>()
  for (const l of out.split(/\r?\n/)) {
    const [a, r, ...p] = l.split('\t')
    if (!p.length) continue
    const file = p.join('\t').replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/')
    m.set(file, { added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) })
  }
  return m
}

// Lista unica: status do git + contagem de linhas + ultima gravacao vista. Arquivo novo (fora do Git) conta as proprias linhas.
export function mergeChanges(status: FileChange[], numstat: ReturnType<typeof parseNumstat>, writes: Map<string, number>, linesOf: (rel: string) => number | null): ChangedFile[] {
  const out = status.filter(f => !ignored(f.path) && !f.path.endsWith('/')).map(f => {
    const n = numstat.get(f.path)
    const lines = f.status === '?' ? linesOf(f.path) : null
    return { ...f, added: n ? n.added : f.status === '?' ? lines : null, removed: n ? n.removed : f.status === '?' ? 0 : null, lastWrite: writes.get(f.path) ?? null }
  })
  return out.sort((a, b) => (b.lastWrite ?? 0) - (a.lastWrite ?? 0) || a.path.localeCompare(b.path)).slice(0, MAX)
}

function countLines(file: string): number | null {
  try {
    const s = fs.statSync(file)
    if (!s.isFile() || s.size > 1 << 20) return null
    const b = fs.readFileSync(file)
    if (b.includes(0)) return null // binario
    let n = 0
    for (const c of b) if (c === 10) n++
    return n + (b.length && b[b.length - 1] !== 10 ? 1 : 0)
  } catch { return null }
}

const watchers = new Map<string, { w: fs.FSWatcher; writes: Map<string, number>; subs: Set<(rel: string) => void> }>()

// Compartilhado: o painel de arquivos e o pulso da home assinam a mesma pasta sem abrir dois observadores.
// Devolve a funcao de sair; o observador fecha quando o ultimo assinante sai.
export function watchDir(dir: string, onWrite: (rel: string) => void): () => void {
  const key = path.resolve(dir).toLowerCase()
  let entry = watchers.get(key)
  if (!entry) {
    const writes = new Map<string, number>(), last = new Map<string, number>(), subs = new Set<(rel: string) => void>()
    try {
      const w = fs.watch(dir, { recursive: true }, (_ev, name) => {
        if (!name) return
        const rel = norm(String(name))
        if (ignored(rel)) return
        const now = Date.now()
        writes.set(rel, now)
        if (now - (last.get(rel) ?? 0) < 250) return // salvamentos em rajada viram um aviso so
        last.set(rel, now)
        for (const f of subs) f(rel)
      })
      w.on('error', () => { w.close(); watchers.delete(key) })
      entry = { w, writes, subs }
      watchers.set(key, entry)
    } catch { return () => {} } // pasta sumiu ou sem permissao: segue so com o git
  }
  const e = entry
  e.subs.add(onWrite)
  return () => {
    e.subs.delete(onWrite)
    if (!e.subs.size && watchers.get(key) === e) { e.w.close(); watchers.delete(key) }
  }
}

export function stopWatching() {
  for (const v of watchers.values()) v.w.close()
  watchers.clear()
}

const writesOf = (dir: string) => watchers.get(path.resolve(dir).toLowerCase())?.writes ?? new Map<string, number>()

export async function changedFiles(dir: string): Promise<{ repo: boolean; files: ChangedFile[] }> {
  let status: FileChange[]
  try { status = parseStatus(await run(dir, ['status', '--porcelain=v1', '--untracked-files=all'])).files }
  catch { // sem Git: so o que o observador viu ser gravado, sem contagem
    return { repo: false, files: [...writesOf(dir)].filter(([rel]) => fs.existsSync(path.join(dir, rel)) && fs.statSync(path.join(dir, rel)).isFile())
      .sort((a, b) => b[1] - a[1]).slice(0, MAX).map(([rel, at]) => ({ path: rel, status: 'M', added: null, removed: null, lastWrite: at })) }
  }
  let num = new Map<string, { added: number | null; removed: number | null }>()
  try { num = parseNumstat(await run(dir, ['diff', '--numstat', 'HEAD'])) } catch {} // repositorio sem commit ainda
  return { repo: true, files: mergeChanges(status, num, writesOf(dir), rel => countLines(path.join(dir, rel))) }
}

// Diff de um arquivo para a previa. O caminho precisa ficar dentro da pasta; texto limitado.
export async function fileDiff(dir: string, rel: string): Promise<string> {
  const base = path.resolve(dir), abs = path.resolve(base, rel)
  if (!abs.startsWith(base + path.sep)) throw new Error('Arquivo fora da pasta da tarefa.')
  const cut = (s: string, n = 300) => { const l = s.split(/\r?\n/); return l.length > n ? [...l.slice(0, n), `… mais ${l.length - n} linhas`].join('\n') : s }
  try {
    const d = await run(base, ['diff', 'HEAD', '--no-color', '--', norm(path.relative(base, abs))])
    if (d.trim()) return cut(d.split(/\r?\n/).filter(l => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join('\n'))
  } catch {}
  if (countLines(abs) === null) return fs.existsSync(abs) ? 'Arquivo binário ou grande demais para a prévia.' : 'Arquivo removido.'
  return cut(fs.readFileSync(abs, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).map(l => `+${l}`).join('\n'), 120) // novo: tudo e adicao
}

// "Sujeira" da pasta: linhas sem commit (soma de +/-) e arquivos alterados. null = sem Git.
export async function dirtOf(dir: string): Promise<{ lines: number; files: number } | null> {
  try {
    const { repo, files } = await changedFiles(dir)
    return repo ? { lines: files.reduce((n, f) => n + (f.added ?? 0) + (f.removed ?? 0), 0), files: files.length } : null
  } catch { return null }
}

// Horarios (ms) dos commits desde `sinceMs`, em qualquer branch (worktrees incluidas).
export async function recentCommits(dir: string, sinceMs: number): Promise<number[]> {
  try {
    const out = await run(dir, ['log', '--all', `--since=${Math.floor(sinceMs / 1000)}`, '--format=%ct'])
    return out.split(/\r?\n/).map(s => Number(s) * 1000).filter(n => n > 0)
  } catch { return [] }
}

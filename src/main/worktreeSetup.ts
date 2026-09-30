// Arquivos nao versionados (ex.: .env, cache .godot/) copiados da pasta do projeto para uma worktree recem-criada. Lista explicita
// por projeto, escolhida pelo usuario; nada e copiado por padrao. Sem Electron.
import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { safeJoin } from './guard.ts'

const MAX = 20
const key = (game: string) => 'worktreeCopy:' + path.resolve(game).toLowerCase()

// Caminho relativo, sem sair da pasta e sem tocar no git/worktrees. Barras normalizadas; pasta termina em "/" so na exibicao.
export function normalizeCopyList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX) throw Error(`Lista inválida: no máximo ${MAX} caminhos.`)
  const out = new Map<string, string>()
  for (const v of raw) {
    if (typeof v !== 'string' || !v.trim() || v.length > 260 || v.includes('\0')) throw Error('Caminho inválido.')
    const rel = v.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
    const parts = rel.split('/')
    if (!rel || path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || parts.some(p => p === '..' || p === '.' || !p)) throw Error(`Use um caminho relativo à pasta do projeto: ${v}`)
    if (['.git', '.worktrees'].includes(parts[0].toLowerCase())) throw Error(`${parts[0]} não pode ser copiado.`)
    out.set(rel.toLowerCase(), rel)
  }
  return [...out.values()]
}
export const copyList = (db: DatabaseSync, game: string): string[] => {
  try { return normalizeCopyList(JSON.parse((db.prepare('SELECT value FROM settings WHERE key=?').get(key(game)) as any)?.value ?? '[]')) } catch { return [] }
}
export function saveCopyList(db: DatabaseSync, game: string, raw: unknown) {
  const list = normalizeCopyList(raw)
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key(game), JSON.stringify(list))
  return list
}

// Sugestoes: o que o git ignora no primeiro nivel do projeto (o que a worktree NAO traz). So leitura.
export function copySuggestions(game: string): string[] {
  let out = ''
  try { out = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], { cwd: game, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 << 20 }) } catch { return [] }
  const top = new Set(out.split(/\r?\n/).filter(Boolean).map(l => l.split('/')[0]))
  top.delete('.worktrees')
  return [...top].sort((a, b) => a.localeCompare(b)).slice(0, 30)
}

// Copia sem sobrescrever o que a worktree ja tem (arquivo versionado vence). Falha num item nao impede os outros.
export function copyIntoWorktree(game: string, wt: string, list: string[]) {
  const copied: string[] = [], missing: string[] = [], failed: { path: string; error: string }[] = []
  for (const rel of list) {
    try {
      const src = safeJoin(game, rel)
      if (!fs.existsSync(src)) { missing.push(rel); continue }
      const dst = path.join(wt, rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false })
      copied.push(fs.statSync(src).isDirectory() ? `${rel}/` : rel)
    } catch (e: any) { failed.push({ path: rel, error: String(e?.message ?? e).slice(0, 200) }) }
  }
  return { copied, missing, failed }
}

export function copyNote(r: ReturnType<typeof copyIntoWorktree>): string | null {
  const lines = [
    r.copied.length ? `Copiado para a worktree: ${r.copied.join(', ')}.` : '',
    r.missing.length ? `Não encontrado na pasta do projeto: ${r.missing.join(', ')}.` : '',
    ...r.failed.map(f => `Falha ao copiar ${f.path}: ${f.error}`)
  ].filter(Boolean)
  return lines.length ? lines.join('\n') : null
}

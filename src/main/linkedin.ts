// Pagina LinkedIn: le a mesa do agente (perfil.md, rascunhos/, videos/) numa pasta propria do app. So arquivos que o agente
// e o usuario escrevem; nada vai para o LinkedIn daqui (quem publica e o usuario). Sem dependencia de 'electron'.
import fs from 'node:fs'
import path from 'node:path'
import { fail } from './guard.ts'

export type Entry = { date: string; kind: string; topic: string; status: string }
export type Draft = { name: string; text: string; at: number }
export type Desk = { hasProfile: boolean; goal: string | null; perWeek: number | null; history: Entry[]; drafts: Draft[]; videos: { name: string; at: number }[] }

// Linhas do Historico no formato da skill: "- AAAA-MM-DD | tipo | tema | status".
const ENTRY = /^\s*[-*]\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|.*)?$/
export function parseProfile(text: string) {
  const field = (k: string) => text.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'mi'))?.[1].replace(/\(.*\)$/, '').trim() || null
  const freq = field('Frequencia')?.match(/\d+/)
  return {
    goal: field('Objetivo'),
    perWeek: freq ? Number(freq[0]) : null,
    history: text.split(/\r?\n/).flatMap(l => { const m = l.match(ENTRY); return m ? [{ date: m[1], kind: m[2], topic: m[3], status: m[4].toLowerCase() }] : [] }),
  }
}

// Segunda-feira da semana de `now` (local), em AAAA-MM-DD.
export const weekStart = (now: Date) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const files = (dir: string, ext: RegExp) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && ext.test(e.name))
      .map(e => ({ name: e.name, at: fs.statSync(path.join(dir, e.name)).mtimeMs })).sort((a, b) => b.at - a.at)
  } catch { return [] }
}

export function readDesk(dir: string): Desk {
  let text = ''
  try { text = fs.readFileSync(path.join(dir, 'perfil.md'), 'utf8') } catch {}
  const drafts = files(path.join(dir, 'rascunhos'), /\.md$/i).slice(0, 8)
    .map(f => ({ ...f, text: fs.readFileSync(path.join(dir, 'rascunhos', f.name), 'utf8').slice(0, 6000) }))
  return { hasProfile: !!text, ...parseProfile(text), drafts, videos: files(path.join(dir, 'videos'), /\.(mp4|mov|webm)$/i).slice(0, 8) }
}

// So um arquivo .md direto em rascunhos/ (o nome vem do renderer).
export function draftFile(dir: string, name: string) {
  if (typeof name !== 'string' || name !== path.basename(name) || !/^[^\\/]+\.md$/i.test(name)) fail('Rascunho invalido.')
  const src = path.join(dir, 'rascunhos', name)
  if (!fs.existsSync(src)) fail('Rascunho nao encontrado.')
  return src
}

// "Publiquei"/"Publicar": o rascunho sai da mesa (rascunhos/publicados/) e vira uma linha do Historico com a data de hoje.
// note: id do post quando publicado pela API.
export function markPublished(dir: string, name: string, now = new Date(), note = '') {
  const src = draftFile(dir, name)
  const topic = (fs.readFileSync(src, 'utf8').split(/\r?\n/).find(l => l.trim()) ?? name).replace(/[#|*]/g, '').trim().slice(0, 70)
  fs.mkdirSync(path.join(dir, 'rascunhos', 'publicados'), { recursive: true })
  fs.renameSync(src, path.join(dir, 'rascunhos', 'publicados', name))
  const profile = path.join(dir, 'perfil.md')
  const cur = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '# Perfil LinkedIn\n\n## Historico\n'
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  fs.writeFileSync(profile, `${cur}${cur.endsWith('\n') ? '' : '\n'}- ${day} | post | ${topic} | publicado${note ? ` | ${note}` : ''}\n`)
}

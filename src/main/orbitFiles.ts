// Prévia local para acompanhar agentes: leitura assíncrona, limitada e confinada à pasta da tarefa.
import fs from 'node:fs'
import path from 'node:path'
import { asInt, asStr, safeJoin } from './guard.ts'
import { ignored } from './fileWatch.ts'

export type FileWindow = {
  path: string
  kind: 'text' | 'image' | 'binary' | 'missing' | 'large'
  startLine: number
  lines: string[]
  totalLines?: number
  modifiedAt?: number
  size?: number
}

const MAX_BYTES = 1 << 20, MAX_LINES = 120, MAX_LINE = 2000
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i

function resolveFile(root: string, requestedPath: unknown) {
  const requested = asStr(requestedPath, 'Arquivo', 2000)
  if (!requested || /[\0\r\n]/.test(requested) || requested.split(/[\\/]/).includes('..')) throw Error('Arquivo inválido.')
  // Não aceitar streams alternativos do Windows; caminhos absolutos de provedores ainda passam por safeJoin.
  if (requested.replace(path.isAbsolute(requested) ? /^[a-z]:[\\/]/i : /^$/, '').includes(':')) throw Error('Arquivo inválido.')
  const abs = safeJoin(root, requested)
  const rel = path.relative(fs.realpathSync(root), abs).split(path.sep).join('/')
  if (ignored(rel.toLowerCase())) throw Error('Arquivo ignorado pela prévia.')
  return { abs, rel }
}

// Eventos de atividade não leem conteúdo; caminhos inválidos, externos ou ignorados não viram alfinetes.
export function relativeActivityPath(root: string, requestedPath: unknown): string | undefined {
  try { return resolveFile(root, requestedPath).rel } catch { return undefined }
}

export async function readFileWindow(root: string, requestedPath: unknown, line?: unknown): Promise<FileWindow> {
  const anchor = line === undefined ? 1 : asInt(line, 'Linha')
  const file = resolveFile(root, requestedPath)
  const base = { path: file.rel, startLine: 1, lines: [] as string[] }
  let input: fs.promises.FileHandle
  try { input = await fs.promises.open(file.abs, 'r') }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, kind: 'missing' }
    throw e
  }
  try {
    const stat = await input.stat(), current = await fs.promises.stat(resolveFile(root, requestedPath).abs)
    if (!stat.isFile()) throw Error('Escolha um arquivo para a prévia.')
    if (stat.ino !== current.ino || stat.dev !== current.dev) throw Error('O arquivo mudou. Atualize a prévia.')
    const metadata = { ...base, modifiedAt: stat.mtimeMs, size: stat.size }
    if (IMAGE.test(file.rel)) return { ...metadata, kind: 'image' }
    if (stat.size > MAX_BYTES) return { ...metadata, kind: 'large' }
    // O byte extra também limita um arquivo que cresceu depois do stat, sem usar readFile sem teto.
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = await input.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    if (bytes > MAX_BYTES) return { ...metadata, kind: 'large', size: (await input.stat()).size }
    const after = await input.stat(), checked = await fs.promises.stat(resolveFile(root, requestedPath).abs)
    if (stat.size !== bytes || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || after.ino !== checked.ino || after.dev !== checked.dev) throw Error('O arquivo mudou. Atualize a prévia.')
    const data = buffer.subarray(0, bytes)
    if (data.includes(0)) return { ...metadata, kind: 'binary' }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
    catch { return { ...metadata, kind: 'binary' } }
    const lines = text.split(/\r?\n/)
    const startLine = Math.max(1, Math.min(anchor - Math.floor(MAX_LINES / 2), lines.length - MAX_LINES + 1))
    return { ...metadata, kind: 'text', startLine, totalLines: lines.length,
      lines: lines.slice(startLine - 1, startLine - 1 + MAX_LINES).map(l => l.length > MAX_LINE ? l.slice(0, MAX_LINE - 1) + '…' : l) }
  } finally { await input.close() }
}

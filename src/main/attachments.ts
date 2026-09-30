// Imagens coladas no chat: gravadas na pasta de dados do app (nunca no projeto) e citadas no texto da mensagem por um marcador.
// O marcador faz a imagem sobreviver a mensagem retida (sends) e ao historico; so caminhos dentro da pasta de anexos valem.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { inside } from './guard.ts'

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/
const MAX_IMAGES = 6, MAX_BYTES = 8 * 1024 * 1024
const MARK = /\[imagem anexada: ([^\]\r\n]+)\]/g

// Grava as imagens (data: URL) e devolve o texto com um marcador por imagem. Nome = hash do conteudo: colar de novo nao duplica.
export function attachImages(dir: string, text: string, images: unknown): string {
  if (images == null) return text
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error(`No maximo ${MAX_IMAGES} imagens por mensagem.`)
  if (!images.length) return text
  fs.mkdirSync(dir, { recursive: true })
  const marks = images.map(img => {
    const m = typeof img === 'string' ? DATA_URL.exec(img) : null
    if (!m) throw new Error('Imagem invalida (use PNG, JPEG ou WebP).')
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > MAX_BYTES) throw new Error('Imagem grande demais (maximo 8 MB).')
    const file = path.join(dir, `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
    fs.writeFileSync(file, buf)
    return `[imagem anexada: ${file}]`
  })
  return [text, ...marks].filter(Boolean).join('\n')
}

// Caminhos citados no texto que existem DENTRO da pasta de anexos (um marcador digitado apontando para outro lugar e ignorado).
export function imagesIn(text: string, root: string): string[] {
  const out = [...text.matchAll(MARK)].map(m => path.resolve(m[1].trim())).filter(p => inside(path.resolve(root), p) && fs.existsSync(p))
  return [...new Set(out)]
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
// Imagem citada numa mensagem, para a miniatura do chat: so arquivos de imagem DENTRO das pastas permitidas (projeto da tarefa e anexos dela).
// Caminho relativo vale a partir da primeira pasta. Qualquer outra coisa devolve null (o chat mostra so o texto). SVG vai como <img>: sem scripts.
export function readImage(p: string, roots: string[]): string | null {
  const mime = MIME[path.extname(p).toLowerCase()]
  if (!mime || !roots.length) return null
  try {
    const real = fs.realpathSync(path.resolve(roots[0], p)) // realpath: um atalho/junction nao escapa das pastas
    if (!roots.some(r => fs.existsSync(r) && inside(fs.realpathSync(r), real))) return null
    const st = fs.statSync(real)
    if (!st.isFile() || st.size > 10 * 1024 * 1024) return null
    return `data:${mime};base64,${fs.readFileSync(real).toString('base64')}`
  } catch { return null }
}

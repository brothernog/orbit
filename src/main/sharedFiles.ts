// Arquivos que o agente PAI mostra ao usuario (ferramenta MCP `send_user_file`). O arquivo da pasta da tarefa e COPIADO para a pasta
// de anexos da tarefa (retrato do momento: editar o original depois nao muda o que foi enviado) e citado no chat por um marcador numa
// nota de sistema, como as imagens coladas (attachments.ts): sobrevive a backups e restauracoes. Filho nunca recebe a ferramenta.
// Nada daqui alimenta prompt ou memoria. Sem dependencia de 'electron' (abrir/mostrar na pasta fica em index.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolDef, ToolResult } from './mcp.ts'
import { inside } from './guard.ts'
import { readImage } from './attachments.ts'

export const SEND_FILE_TOOL_NAME = 'send_user_file'
export const SEND_FILE_TOOL: ToolDef = {
  name: SEND_FILE_TOOL_NAME,
  description: 'Mostra ao usuario, no chat, um arquivo que voce gerou ou quer que ele veja (relatorio, imagem, captura, build pequena, log). O arquivo precisa estar dentro da pasta da tarefa; vai uma copia do momento. Nao espera resposta: continue o trabalho. Nao use para arquivos que voce so editou no codigo (o usuario ja ve as alteracoes).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Caminho do arquivo, relativo a pasta da tarefa ou absoluto dentro dela.' },
      caption: { type: 'string', description: 'Uma frase opcional ao usuario: o que e e o que olhar.' }
    },
    required: ['path']
  }
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MARK = /\[arquivo enviado: ([^\]\r\n]+)\]/g
// Abrir com o programa padrao so para tipos que nao executam nada; o resto so "Mostrar na pasta".
const OPENABLE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md', '.log', '.csv', '.json'])

// cwd: pasta da tarefa (projeto ou worktree); dir: pasta de envios da tarefa (dentro dos anexos). note: texto da nota no chat.
export function sendUserFile(cwd: string, dir: string, args: any): ToolResult & { note?: string } {
  const err = (m: string) => ({ text: `Arquivo nao enviado: ${m}`, isError: true })
  const p = typeof args?.path === 'string' ? args.path.trim() : ''
  if (!p || p.length > 1000) return err('informe path (ate 1000 caracteres).')
  const caption = typeof args?.caption === 'string' ? args.caption.replace(MARK, '').trim().slice(0, 500) : ''
  let real: string
  try {
    real = fs.realpathSync(path.resolve(cwd, p)) // realpath: atalho/junction nao escapa da pasta
    if (!inside(fs.realpathSync(cwd), real)) return err('o arquivo precisa estar dentro da pasta da tarefa.')
  } catch { return err('arquivo inexistente.') }
  const st = fs.statSync(real)
  if (!st.isFile()) return err('nao e um arquivo.')
  if (st.size > MAX_FILE_BYTES) return err(`maior que ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
  const buf = fs.readFileSync(real)
  const dest = path.join(dir, crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16), path.basename(real))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf) // mesmo conteudo e nome: reenviar nao duplica
  return {
    text: `Arquivo ${path.basename(real)} (${st.size} bytes) mostrado ao usuario no chat. Continue o trabalho.`, isError: false,
    note: `↳ Arquivo enviado pelo agente${caption ? `: ${caption}` : ''}\n[arquivo enviado: ${dest}]`
  }
}

// Caminho real de um arquivo enviado, so se estiver DENTRO da pasta de envios da tarefa (um marcador digitado apontando para fora e ignorado).
export function sharedPath(p: string, dir: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(p))
    return inside(fs.realpathSync(dir), real) && fs.statSync(real).isFile() ? real : null
  } catch { return null }
}

export type SharedInfo = { name: string; size: number; image: string | null; openable: boolean }
export function sharedInfo(p: string, dir: string): SharedInfo | null {
  const real = sharedPath(p, dir)
  if (!real) return null
  const ext = path.extname(real).toLowerCase()
  return { name: path.basename(real), size: fs.statSync(real).size, image: readImage(real, [dir]), openable: OPENABLE.has(ext) }
}
export const canOpen = (p: string) => OPENABLE.has(path.extname(p).toLowerCase())

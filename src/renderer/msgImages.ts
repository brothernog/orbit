// Imagens citadas numa mensagem do chat: anexos do usuario (marcador) e arquivos de imagem que o agente menciona.
// Funcoes puras; quem decide se o arquivo pode ser lido e o processo principal (taskImage).
const MARK = /\[imagem anexada: ([^\]\r\n]+)\]/g
const EXT = String.raw`\.(?:png|jpe?g|gif|webp|svg)`
// Em ordem: ![alt](caminho), `caminho` (aceita espacos, ex.: pasta do projeto) e caminho solto sem espacos.
const REFS = new RegExp(String.raw`!\[[^\]]*\]\(<?([^)<>\r\n]+?${EXT})>?\)|\x60([^\x60\r\n]+?${EXT})\x60|(?:^|[\s(])((?:[A-Za-z]:)?[\w./\\-]+${EXT})(?=$|[\s),.;:])`, 'gim')

// marksOnly: mensagem do usuario mostra so o que ele anexou (um caminho citado por ele nao e imagem enviada).
export function imageRefs(text: string, marksOnly = false): string[] {
  const out = [...text.matchAll(MARK)].map(m => m[1].trim())
  if (marksOnly) return out
  for (const m of text.replace(MARK, '').matchAll(REFS)) {
    const p = (m[1] ?? m[2] ?? m[3]).trim()
    if (!/^[a-z][\w+.-]*:\/\//i.test(p)) out.push(p) // endereco da internet nunca: abrir a mensagem nao pode avisar um site
  }
  return [...new Set(out)].slice(0, 12)
}

// Arquivos que o agente enviou (send_user_file): marcador na nota de sistema. O processo principal valida o caminho.
const FILE = /\[arquivo enviado: ([^\]\r\n]+)\]/g
export const fileRefs = (text: string) => [...new Set([...text.matchAll(FILE)].map(m => m[1].trim()))]
// Legenda do agente na nota (sharedFiles.ts escreve "↳ Arquivo enviado pelo agente: <legenda>"); sem legenda, vazio.
export const sentCaption = (plain: string) => plain.replace(/^↳ Arquivo enviado pelo agente:?\s*/, '').trim()

// Texto sem as linhas de marcador (a miniatura e o cartao do arquivo as substituem).
export const stripMarks = (text: string) => text.replace(MARK, '').replace(FILE, '').replace(/\n+$/, '').trim()

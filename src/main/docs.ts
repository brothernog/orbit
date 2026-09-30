// Documentos .md do projeto. Criar nunca sobrescreve; editar exige o texto que a interface leu, e recusa se o arquivo mudou desde entao.
import fs from 'node:fs'
import { safeJoin } from './guard.ts'

const target = (root: string, rel: string) => {
  if (!/\.md$/i.test(rel)) throw new Error('So arquivos .md')
  return safeJoin(root, rel)
}

export const createDoc = (root: string, rel: string, text: string) => fs.writeFileSync(target(root, rel), text, { flag: 'wx' })

// ponytail: ler-comparar-gravar sem lock; uma gravacao externa entre os dois passos (milissegundos) ainda venceria. Lock/rename atomico se importar.
export function editDoc(root: string, rel: string, seen: string, text: string) {
  const file = target(root, rel)
  if (fs.readFileSync(file, 'utf8') !== seen) throw new Error('O arquivo mudou desde que foi lido. Recarregue antes de editar.')
  fs.writeFileSync(file, text)
}

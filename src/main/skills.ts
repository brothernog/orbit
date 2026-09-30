// Skills ja existentes (resources/skills) entregues SOB DEMANDA pela ferramenta MCP read_task_skill, em vez de injetadas a cada turno.
// So os dois recursos empacotados abaixo podem ser lidos (enum fixo; o nome nunca vira caminho), por papel: o pai consulta delegacao e memoria,
// o filho so memoria. dashboard-token-efficiency e um guia manual geral e NAO e carregado por aqui. Sem dependencia de 'electron'.
import fs from 'node:fs'
import path from 'node:path'
import { sha } from './artifacts.ts'
import type { ToolDef } from './mcp.ts'

export type Role = 'parent' | 'child'
export const SKILLS = {
  'task-delegation': { roles: ['parent'] as Role[], summary: 'quando e como delegar (ordem, escopo, aprovacao de contexto, continuar o mesmo filho, ler o retorno)' },
  'task-memory': { roles: ['parent', 'child'] as Role[], summary: 'consultar/registrar a memoria da tarefa, leitura por intervalo (readToken) e evidencia de testes (conservadora)' },
  // Terceiros (MIT, ver resources/skills/ponytail/LICENSE): o menor codigo que funciona. Carregue antes de escrever ou revisar codigo.
  ponytail: { roles: ['parent', 'child'] as Role[], summary: 'antes de escrever/revisar codigo: o minimo que funciona (YAGNI, reusar o que existe, stdlib/nativo antes de dependencia, menor diff)' },
  linkedin: { roles: ['parent'] as Role[], summary: 'LinkedIn do usuario: briefing, rascunhos no tom dele, conexoes sugeridas e videos por gravacao de tela + ffmpeg; nunca publica sozinho' }
} as const
export type SkillName = keyof typeof SKILLS
export const SKILL_NAMES = Object.keys(SKILLS) as SkillName[]
export const READ_SKILL_TOOL_NAME = 'read_task_skill'
export const skillsFor = (role: Role): SkillName[] => SKILL_NAMES.filter(n => (SKILLS[n].roles as Role[]).includes(role))

// Descricao curta por papel: so o que aquele papel pode consultar; o conteudo so chega quando pedido.
export const skillTool = (role: Role): ToolDef => ({
  name: READ_SKILL_TOOL_NAME,
  description: `Instrucoes detalhadas sob demanda: ${skillsFor(role).map(n => `${n} (${SKILLS[n].summary})`).join('; ')}. Na mesma sessao, reler devolve so a versao; reload=true (apos compactacao) devolve o texto.`,
  inputSchema: { type: 'object', properties: { name: { type: 'string', enum: skillsFor(role) }, reload: { type: 'boolean', description: 'Texto de novo.' } }, required: ['name'] }
})

// Onde procurar os arquivos empacotados (definido pelo processo principal: pasta do app em desenvolvimento e executando o build; recursos do pacote).
let roots: string[] = []
export const setSkillRoots = (r: string[]) => { roots = r.filter(Boolean) }

export class SkillError extends Error {}
function skillDir(): string {
  const found = roots.find(r => { try { return fs.statSync(r).isDirectory() } catch { return false } })
  if (!found) throw new SkillError(`Recursos de skills nao encontrados no pacote do app (procurado em: ${roots.join('; ') || 'nenhum local configurado'}). Nenhuma instrucao foi inventada: reinstale ou reconstrua o app.`)
  return found
}

// Le SO o arquivo fixo `<raiz>/<nome>/SKILL.md` de um nome do enum; devolve o corpo sem o front matter, com versao (hash do conteudo).
export function readSkill(name: string): { name: SkillName; version: string; text: string } {
  if (!Object.hasOwn(SKILLS, name)) throw new SkillError(`Skill desconhecida. Opcoes: ${SKILL_NAMES.join(', ')}.`)
  const file = path.join(skillDir(), name, 'SKILL.md')
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch { throw new SkillError(`Arquivo da skill "${name}" ausente no pacote do app (${file}). Nenhuma instrucao foi inventada: reinstale ou reconstrua o app.`) }
  const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
  return { name: name as SkillName, version: sha(raw).slice(0, 12), text }
}

// Skills ja entregues por sessao (memoria; limitado): a mesma sessao nao recebe o mesmo texto duas vezes sem pedir reload.
const MAX_SESSIONS = 200
const delivered = new Map<string, Map<string, string>>()
export const dropSkillSession = (session: string) => delivered.delete(session)

export function loadSkill(session: string, role: Role, args: { name?: unknown; reload?: unknown }): string {
  const name = typeof args.name === 'string' ? args.name : ''
  if (!Object.hasOwn(SKILLS, name)) throw new SkillError(`name invalido. Opcoes para o seu papel: ${skillsFor(role).join(', ')}.`)
  if (!(SKILLS[name as SkillName].roles as Role[]).includes(role)) throw new SkillError(`A skill "${name}" nao esta disponivel para o seu papel. Opcoes: ${skillsFor(role).join(', ')}.`)
  const s = readSkill(name)
  let mine = delivered.get(session)
  if (!mine) { delivered.set(session, (mine = new Map())); if (delivered.size > MAX_SESSIONS) delivered.delete(delivered.keys().next().value as string) }
  if (mine.get(name) === s.version && args.reload !== true)
    return `Skill ${name} (versao ${s.version}) ja foi carregada nesta sessao; o texto nao foi reenviado. Se o contexto foi compactado e voce perdeu as instrucoes, chame de novo com reload=true.`
  mine.set(name, s.version)
  return `Skill ${name} (versao ${s.version}):\n\n${s.text}`
}

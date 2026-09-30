// Skills ja existentes (resources/skills) entregues SOB DEMANDA pela ferramenta MCP read_task_skill, em vez de injetadas a cada turno.
// So os dois recursos empacotados abaixo podem ser lidos (enum fixo; o nome nunca vira caminho), por papel: o pai consulta delegacao e memoria,
// o filho so memoria. dashboard-token-efficiency e um guia manual geral e NAO e carregado por aqui. Sem dependencia de 'electron'.
import fs from 'node:fs'
import path from 'node:path'
import { sha } from './artifacts.ts'
import type { EngineId } from './engines.ts'
import type { ToolDef } from './mcp.ts'

export type Role = 'parent' | 'child'
export const SKILLS = {
  'task-delegation': { roles: ['parent'] as Role[], summary: 'quando e como delegar (ordem, escopo, aprovacao de contexto, continuar o mesmo filho, ler o retorno)' },
  'task-memory': { roles: ['parent', 'child'] as Role[], summary: 'consultar/registrar a memoria da tarefa, leitura por intervalo (readToken) e evidencia de testes (conservadora)' },
  // Terceiros (MIT, ver resources/skills/ponytail/LICENSE): o menor codigo que funciona. Carregue antes de escrever ou revisar codigo.
  ponytail: { roles: ['parent', 'child'] as Role[], summary: 'antes de escrever/revisar codigo: o minimo que funciona (YAGNI, reusar o que existe, stdlib/nativo antes de dependencia, menor diff)' },
  linkedin: { roles: ['parent'] as Role[], summary: 'LinkedIn do usuario: briefing, rascunhos no tom dele, conexoes sugeridas e videos por gravacao de tela + ffmpeg; nunca publica sozinho' },
  // Engines: so aparecem quando o organizador concedeu a engine a esta execucao (engines.ts).
  godot: { roles: ['parent', 'child'] as Role[], engine: 'godot', summary: 'fluxo Godot economico: godot_* antes de ler .tscn, editar cenas/scripts com seguranca e verificar' },
  unity: { roles: ['parent', 'child'] as Role[], engine: 'unity', summary: 'fluxo Unity economico: unity_* antes de ler YAML, GUID/.meta seguros, testes batchmode e diagnostico' },
  blender: { roles: ['parent', 'child'] as Role[], engine: 'blender', summary: 'fluxo Blender economico: blender_* antes de scripts, auditoria antes de exportar, alteracoes por bpy seguras' }
} as const satisfies Record<string, { roles: Role[]; summary: string; engine?: EngineId }>
export type SkillName = keyof typeof SKILLS
export const SKILL_NAMES = Object.keys(SKILLS) as SkillName[]
export const READ_SKILL_TOOL_NAME = 'read_task_skill'
const engineOfSkill = (n: SkillName): EngineId | undefined => (SKILLS[n] as { engine?: EngineId }).engine
export const skillsFor = (role: Role, engines: readonly EngineId[] = []): SkillName[] => SKILL_NAMES.filter(n => (SKILLS[n].roles as Role[]).includes(role) && (!engineOfSkill(n) || engines.includes(engineOfSkill(n)!)))

// Descricao curta por papel: so o que aquele papel pode consultar; o conteudo so chega quando pedido.
export const skillTool = (role: Role, engines: readonly EngineId[] = []): ToolDef => ({
  name: READ_SKILL_TOOL_NAME,
  description: `Instrucoes detalhadas sob demanda: ${skillsFor(role, engines).map(n => `${n} (${SKILLS[n].summary})`).join('; ')}. Na mesma sessao, reler devolve so a versao; reload=true (apos compactacao) devolve o texto.`,
  inputSchema: { type: 'object', properties: { name: { type: 'string', enum: skillsFor(role, engines) }, reload: { type: 'boolean', description: 'Texto de novo.' } }, required: ['name'] }
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

export function loadSkill(session: string, role: Role, args: { name?: unknown; reload?: unknown }, engines: readonly EngineId[] = []): string {
  const name = typeof args.name === 'string' ? args.name : ''
  if (!Object.hasOwn(SKILLS, name)) throw new SkillError(`name invalido. Opcoes para o seu papel: ${skillsFor(role, engines).join(', ')}.`)
  if (!skillsFor(role, engines).includes(name as SkillName)) throw new SkillError(`A skill "${name}" nao esta disponivel para o seu papel ou organizador. Opcoes: ${skillsFor(role, engines).join(', ')}.`)
  const s = readSkill(name)
  let mine = delivered.get(session)
  if (!mine) { delivered.set(session, (mine = new Map())); if (delivered.size > MAX_SESSIONS) delivered.delete(delivered.keys().next().value as string) }
  if (mine.get(name) === s.version && args.reload !== true)
    return `Skill ${name} (versao ${s.version}) ja foi carregada nesta sessao; o texto nao foi reenviado. Se o contexto foi compactado e voce perdeu as instrucoes, chame de novo com reload=true.`
  mine.set(name, s.version)
  return `Skill ${name} (versao ${s.version}):\n\n${s.text}`
}

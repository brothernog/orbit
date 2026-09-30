// Skills sob demanda: so os dois recursos empacotados, por papel, sem caminho arbitrario, com versao e sem repetir o texto na mesma sessao.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import { openGrant } from './consent.ts'
import { DEFAULT_LIMITS, estimateTokens } from './limits.ts'
import { runtimeBrief } from './prompt.ts'
import { dropSkillSession, readSkill, setSkillRoots, SKILLS, SKILL_NAMES, skillsFor, skillTool, SkillError } from './skills.ts'
import { callTaskTool, toolsFor, type ToolCtx } from './taskContext.ts'
import type { ToolResult } from './mcp.ts'
import { createTask } from './tasks.ts'

const REAL = path.resolve(import.meta.dirname, '..', '..', 'resources', 'skills') // a pasta empacotada de verdade (a mesma que o app usa)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-skills-'))
const db = openDb(path.join(tmp, 't.db'))
const T = createTask(db, tmp, 't')
const ctx = (role: 'parent' | 'child', session: string): ToolCtx => ({
  taskId: T, lineage: role === 'parent' ? 'chat:1:codex:' : 'del:1', role, cwd: tmp, scope: [],
  auth: openGrant(db, { taskId: T, recipient: { logicalId: role === 'parent' ? 'chat:1:codex:' : 'del:1', provider: 'codex', profile: '', model: null, effort: null, workspace: tmp, scope: [] }, sessionId: session })
})
const call = (c: ToolCtx, args: any) => callTaskTool(db, DEFAULT_LIMITS, c, 'read_task_skill', args) as ToolResult

test('os recursos empacotados existem e a skill geral NAO e carregavel por esta ferramenta', () => {
  setSkillRoots([REAL])
  for (const n of SKILL_NAMES) { const s = readSkill(n); assert.ok(s.text.length > 500 && /^[0-9a-f]{12}$/.test(s.version) && !s.text.startsWith('---'), n) } // sem front matter, com versao
  assert.deepEqual(SKILL_NAMES, ['task-delegation', 'task-memory', 'ponytail', 'linkedin', 'godot', 'unity', 'blender'])
  assert.throws(() => readSkill('dashboard-token-efficiency'), SkillError) // guia manual: nunca carregado automaticamente
  assert.ok(fs.existsSync(path.join(REAL, 'dashboard-token-efficiency', 'SKILL.md'))) // continua no repositorio como guia manual
})

test('anuncia so o que o papel pode consultar: pai delegacao e memoria; filho so memoria', () => {
  assert.deepEqual(skillsFor('parent'), ['task-delegation', 'task-memory', 'ponytail', 'linkedin']); assert.deepEqual(skillsFor('child'), ['task-memory', 'ponytail'])
  const p = skillTool('parent') as any, c = skillTool('child') as any
  assert.deepEqual(p.inputSchema.properties.name.enum, ['task-delegation', 'task-memory', 'ponytail', 'linkedin']); assert.deepEqual(c.inputSchema.properties.name.enum, ['task-memory', 'ponytail'])
  assert.ok(!/task-delegation/.test(c.description) && /task-delegation/.test(p.description) && !/token-efficiency/.test(p.description + c.description))
  for (const role of ['parent', 'child'] as const) assert.ok(toolsFor(role).some(t => t.name === 'read_task_skill'))
  // o anuncio e curto: nao carrega o conteudo das skills
  assert.ok(estimateTokens(JSON.stringify(skillTool('parent')).length) < 250)
})

test('conteudo so sob demanda: nada das skills entra no resumo permanente; o ponteiro e curto e por papel', () => {
  setSkillRoots([REAL])
  const brief = runtimeBrief({ memoryTools: true, workspaceTools: true, skills: 'parent' })
  const body = readSkill('task-memory').text
  assert.ok(!brief.includes(body.slice(0, 60)) && brief.length < 1600)
  assert.match(brief, /read_task_skill \(task-memory, task-delegation, ponytail, linkedin\)/)
  assert.match(runtimeBrief({ memoryTools: true, workspaceTools: true, skills: 'child' }), /read_task_skill \(task-memory, ponytail\);/)
  assert.ok(!/read_task_skill/.test(runtimeBrief({ memoryTools: false, workspaceTools: false }))) // sem MCP compativel: so o resumo minimo, sem prometer ferramenta
})

test('carregamento por chamada: texto na primeira vez, so a versao na repeticao da mesma sessao, reload apos compactacao, outra sessao recebe', () => {
  setSkillRoots([REAL])
  const a = ctx('parent', 'sk-1')
  const first = call(a, { name: 'task-memory' })
  assert.equal(first.isError, false); assert.match(first.text, /^Skill task-memory \(versao [0-9a-f]{12}\):\n\n# Memoria da tarefa/)
  const again = call(a, { name: 'task-memory' })
  assert.match(again.text, /ja foi carregada nesta sessao; o texto nao foi reenviado[\s\S]*reload=true/); assert.ok(again.text.length < 250)
  assert.equal(again.text.match(/versao ([0-9a-f]{12})/)![1], first.text.match(/versao ([0-9a-f]{12})/)![1]) // mesma versao informada
  assert.match(call(a, { name: 'task-memory', reload: true }).text, /# Memoria da tarefa/) // releitura explicita apos compactacao
  assert.match(call(ctx('parent', 'sk-2'), { name: 'task-memory' }).text, /# Memoria da tarefa/) // outra sessao nao herda "ja carregada"
  assert.match(call(a, { name: 'task-delegation' }).text, /# Delegar com economia/) // as duas skills sao independentes
  dropSkillSession(a.auth.authId)
  assert.match(call(a, { name: 'task-memory' }).text, /# Memoria da tarefa/) // sessao encerrada/reiniciada: volta a carregar
})

test('papel e entrada: filho nao ganha delegacao; nome invalido e caminho arbitrario sao recusados', () => {
  setSkillRoots([REAL])
  const child = ctx('child', 'sk-c')
  assert.match(call(child, { name: 'task-delegation' }).text, /nao esta disponivel para o seu papel/); assert.equal(call(child, { name: 'task-delegation' }).isError, true)
  assert.equal(call(child, { name: 'task-memory' }).isError, false)
  for (const name of ['../../package.json', '..\\..\\package.json', 'task-memory/../task-delegation', '/etc/passwd', 'C:/Windows/win.ini', 'dashboard-token-efficiency', 'TASK-MEMORY', '', null, 7, {}, ['task-memory']])
    assert.equal(call(ctx('parent', 'sk-p'), { name }).isError, true, JSON.stringify(name))
  assert.equal(call(ctx('parent', 'sk-p'), {}).isError, true)
  assert.equal(Object.hasOwn(SKILLS, '__proto__'), false); assert.equal(call(ctx('parent', 'sk-p'), { name: '__proto__' }).isError, true)
})

test('empacotamento: recurso ausente e pasta ausente falham com mensagem clara e sem inventar instrucoes', () => {
  setSkillRoots([path.join(tmp, 'nao-existe')])
  const r = call(ctx('parent', 'sk-x'), { name: 'task-memory' })
  assert.equal(r.isError, true); assert.match(r.text, /Recursos de skills nao encontrados no pacote do app[\s\S]*nao-existe[\s\S]*Nenhuma instrucao foi inventada/)
  const half = path.join(tmp, 'half'); fs.mkdirSync(path.join(half, 'task-delegation'), { recursive: true })
  fs.writeFileSync(path.join(half, 'task-delegation', 'SKILL.md'), '---\nname: x\n---\ncorpo curto')
  setSkillRoots([path.join(tmp, 'nao-existe'), half]) // usa a primeira raiz que existe (dev x pacote)
  assert.equal(readSkill('task-delegation').text, 'corpo curto')
  const missing = call(ctx('parent', 'sk-x'), { name: 'task-memory' })
  assert.equal(missing.isError, true); assert.match(missing.text, /Arquivo da skill "task-memory" ausente no pacote do app/)
  setSkillRoots([])
  assert.match(call(ctx('parent', 'sk-x'), { name: 'task-memory' }).text, /nenhum local configurado/)
  setSkillRoots([REAL])
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('skills de engine: so entram no anuncio, no resumo e na leitura quando o organizador concedeu a engine', () => {
  setSkillRoots([REAL])
  assert.deepEqual(skillsFor('parent', ['unity']), ['task-delegation', 'task-memory', 'ponytail', 'linkedin', 'unity'])
  assert.deepEqual(skillsFor('child', ['blender', 'godot']), ['task-memory', 'ponytail', 'godot', 'blender'])
  assert.deepEqual((skillTool('child', ['unity']) as any).inputSchema.properties.name.enum, ['task-memory', 'ponytail', 'unity'])
  assert.ok(!/unity|blender|godot/.test(JSON.stringify(skillTool('parent'))))
  const brief = runtimeBrief({ memoryTools: true, workspaceTools: false, skills: 'parent', engines: ['unity'] })
  assert.match(brief, /read_task_skill \(task-memory, task-delegation, ponytail, linkedin, unity\)/); assert.match(brief, /Projeto Unity: consulte unity_\*/)
  assert.ok(!/Projeto/.test(runtimeBrief({ memoryTools: false, workspaceTools: false, engines: ['unity'] }))) // sem MCP: nao promete ferramenta
  const c = ctx('child', 'sk-e')
  assert.match(call(c, { name: 'unity' }).text, /nao esta disponivel para o seu papel ou organizador/) // sem concessao
  assert.equal(call({ ...c, engines: ['unity'] }, { name: 'unity' }).isError, false)
  assert.equal(call({ ...c, engines: ['unity'] }, { name: 'blender' }).isError, true)
})

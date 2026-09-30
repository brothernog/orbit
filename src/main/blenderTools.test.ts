import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blenderStats, setBlenderScriptRoots } from './blender.ts'
import { BLENDER_TOOLS, callBlenderTool } from './blenderTools.ts'
import { openGrant } from './consent.ts'
import { openDb } from './db.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import type { ToolCtx } from './taskContext.ts'
import { createTask } from './tasks.ts'

// Blender real (GPD_BLENDER_EXE ou "blender" no PATH) gera os fixtures e responde as consultas; sem ele, os testes e2e são pulados.
const EXE = process.env.GPD_BLENDER_EXE || 'blender'
const HAS_BLENDER = (() => { try { return /Blender \d/.test(spawnSync(EXE, ['--version'], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '') } catch { return false } })()
const e2e = { skip: HAS_BLENDER ? false : 'Blender indisponível (defina GPD_BLENDER_EXE)' }

setBlenderScriptRoots([path.resolve('resources/blender')])
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-blender-tools-'))
const cwd = path.join(root, 'project'), outside = path.join(root, 'outside')
fs.mkdirSync(path.join(cwd, 'models'), { recursive: true }); fs.mkdirSync(path.join(cwd, 'logs')); fs.mkdirSync(outside)
const db = openDb(path.join(root, 'test.db')), taskId = createTask(db, cwd, 'Blender')
const group = { id: 'blender', name: 'Blender', color: '#88aabb', games: [cwd], open: true, blender: { enabled: true, executable: EXE } }
const setGroups = (groups: any[] = [group]) => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('projectGroups',?)").run(JSON.stringify(groups))
setGroups()
const context = (scope: string[] = []): ToolCtx => {
  const lineage = `del:${taskId}`
  return { taskId, lineage, auth: openGrant(db, { taskId, recipient: { logicalId: lineage, provider: 'codex', profile: '', workspace: cwd, scope } }), cwd, scope, role: 'child' }
}
const ctx = context()
const call = (name: string, args: any = {}, c = ctx, chars = 8000, signal?: AbortSignal) => callBlenderTool(db, { ...DEFAULT_LIMITS, queryChars: chars }, c, 'blender', name, args, signal)
const ok = async (name: string, args: any = {}, c = ctx, chars = 8000) => { const r = await call(name, args, c, chars); assert.equal(r.isError, false, r.text); return r.text }
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

const GEN = `
import bpy, sys, os
out = sys.argv[sys.argv.index('--') + 1]; d = os.path.dirname(out)
bpy.ops.mesh.primitive_uv_sphere_add(); bpy.context.object.name = 'LibRock'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(d, 'lib.blend'))
bpy.ops.wm.read_factory_settings(use_empty=True)
with bpy.data.libraries.load(os.path.join(d, 'lib.blend'), link=True, relative=True) as (src, dst):
    dst.objects = ['LibRock']
for o in dst.objects: bpy.context.scene.collection.objects.link(o)
props = bpy.data.collections.new('Props'); bpy.context.scene.collection.children.link(props)
bpy.ops.mesh.primitive_cube_add(); cube = bpy.context.object; cube.name = 'Crate'; cube.scale = (2, 1, 1); cube.rotation_euler[2] = 0.5
mat = bpy.data.materials.new('Wood'); mat.use_nodes = True; nt = mat.node_tree; bsdf = nt.nodes['Principled BSDF']
tex = nt.nodes.new('ShaderNodeTexImage'); img = bpy.data.images.new('wood', 4, 4); img.source = 'FILE'; img.filepath = '//textures/wood_missing.png'; tex.image = img
nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
nimg = bpy.data.images.new('wood_n', 4, 4); nimg.source = 'FILE'; nimg.filepath = '//textures/wood_n.png'
nm = nt.nodes.new('ShaderNodeNormalMap'); t2 = nt.nodes.new('ShaderNodeTexImage'); t2.image = nimg
nt.links.new(t2.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
cube.data.materials.append(mat); cube.modifiers.new('Bevel', 'BEVEL').segments = 3; cube['game_id'] = 7
bpy.ops.mesh.primitive_circle_add(vertices=12, fill_type='NGON', location=(4, 0, 0)); bpy.context.object.name = 'Disc'; bpy.context.object.scale = (-1, 1, 1)
bpy.ops.mesh.primitive_plane_add(location=(0, 4, 0)); p = bpy.context.object; p.name = 'Slotty'; p.data.materials.append(None)
bpy.ops.mesh.primitive_circle_add(vertices=8, location=(0, -4, 0)); bpy.context.object.name = 'Wire'
bpy.ops.mesh.primitive_cube_add(location=(6, 6, 0)); c2 = bpy.context.object; c2.name = 'Crate.001'
c2.data.materials.append(mat); c2.shape_key_add(name='Basis'); c2.shape_key_add(name='Squash'); c2.modifiers.new('Sub', 'SUBSURF'); c2.parent = cube
bpy.data.materials.new('Unused').use_fake_user = True
for o in (cube, c2): bpy.context.scene.collection.objects.unlink(o); props.objects.link(o)
bpy.ops.object.camera_add(); bpy.context.scene.camera = bpy.context.object
os.makedirs(os.path.join(d, 'textures'), exist_ok=True)
open(os.path.join(d, 'textures', 'wood_n.png'), 'wb').write(bytes.fromhex('89504e470d0a1a0a0000000d4948445200000100000000800802000000'))
bpy.ops.wm.save_as_mainfile(filepath=out)
os.remove(os.path.join(d, 'lib.blend'))
# cena grande: 3000 objetos compartilhando uma malha
bpy.ops.wm.read_factory_settings(use_empty=True)
me = bpy.data.meshes.new('M'); me.from_pydata([(0,0,0),(1,0,0),(1,1,0),(0,1,0),(0.5,1.5,0)], [], [(0,1,2,4,3)])
for i in range(3000): bpy.context.scene.collection.objects.link(bpy.data.objects.new('Tree%04d' % i, me))
for i in range(400): bpy.context.scene.collection.objects.link(bpy.data.objects.new('P%dX' % i, me))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(d, 'forest.blend'), compress=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.collection.objects.link(bpy.data.objects.new('Evil\\n[ERRO] forjado', None))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(d, 'evil.blend'))
`
const scenePath = path.join(cwd, 'models', 'scene.blend')
let sceneHash = ''
test.before(() => {
  if (!HAS_BLENDER) return
  fs.writeFileSync(path.join(root, 'gen.py'), GEN)
  const r = spawnSync(EXE, ['-b', '--factory-startup', '-Y', '--python', path.join(root, 'gen.py'), '--', scenePath], { encoding: 'utf8', timeout: 120_000 })
  assert.ok(fs.existsSync(scenePath), r.stdout + r.stderr)
  sceneHash = crypto.createHash('sha256').update(fs.readFileSync(scenePath)).digest('hex')
  fs.copyFileSync(scenePath, scenePath + '1')
})

test('esquemas curtos e argumentos fora do esquema recusados', async () => {
  assert.deepEqual(BLENDER_TOOLS.map(t => t.name), ['blender_project', 'blender_scene', 'blender_diagnostics'])
  assert.ok(JSON.stringify(BLENDER_TOOLS).length < 2000, String(JSON.stringify(BLENDER_TOOLS).length))
  assert.match((await call('blender_scene', { path: 'models/scene.blend', script: 'x.py' })).text, /Argumento não permitido/)
  assert.match((await call('blender_run', {})).text, /desconhecida/)
})

test('contexto: organizador, tarefa, workspace e escopo revalidados; caminhos e argumentos validados', async () => {
  try {
    setGroups([{ ...group, blender: { ...group.blender, enabled: false } }])
    assert.equal((await call('blender_project')).isError, true)
  } finally { setGroups() }
  assert.equal((await callBlenderTool(db, DEFAULT_LIMITS, ctx, 'other', 'blender_project', {})).isError, true)
  assert.equal((await call('blender_project', {}, { ...ctx, taskId: taskId + 1 })).isError, true)
  fs.writeFileSync(path.join(outside, 'x.blend'), 'BLENDER-v400'); fs.writeFileSync(path.join(cwd, 'notes.txt'), 'x')
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.git', 'g.blend'), 'BLENDER-v400')
  fs.symlinkSync(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const p of ['../outside/x.blend', path.join(outside, 'x.blend'), '.git/g.blend', 'linked/x.blend', 'notes.txt', 'missing.blend']) {
    const r = await call('blender_scene', { path: p })
    assert.equal(r.isError, true, p); assert.doesNotMatch(r.text, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), p)
  }
  fs.writeFileSync(path.join(cwd, 'models', 'fake.blend'), 'BLENDER-v400')
  for (const args of [{ mode: 'run' }, { mode: 'object' }, { object: 'a\nb' }, { object: 'x'.repeat(201) }, { mode: 'images', scene: 'S' }, { offset: -1 }])
    assert.equal((await call('blender_scene', { path: 'models/fake.blend', ...args })).isError, true, JSON.stringify(args))
  assert.match((await call('blender_scene', { path: 'models/fake.blend' }, context(['logs']))).text, /fora do escopo/)
})

test('blender_project: versão, cabeçalhos, compressão e backups sem abrir arquivos', e2e, async () => {
  const runs = blenderStats.runs
  const t = await ok('blender_project')
  assert.match(t, /^Blender · projeto/); assert.match(t, /Blender \d+\.\d+\.\d+ \(executável configurado/)
  assert.match(t, /models\/scene\.blend · \d+ KiB · Blender \d\.\d+ · 1 backup/)
  assert.match(t, /models\/forest\.blend · \d+ KiB · Blender \d\.\d+ · zstd/)
  assert.match(t, /backups \.blend1\/\.blend@ ignorados: 1/)
  assert.doesNotMatch(t, /outside|\.git\/g\.blend/)
  assert.equal(blenderStats.runs, runs, 'não executa o script de inspeção')
  const scoped = await ok('blender_project', {}, context(['models/forest.blend']))
  assert.doesNotMatch(scoped, /scene\.blend/)
})

test('blender_scene summary/object/materials/images/libraries/audit em .blend real, sem modificar o arquivo', e2e, async () => {
  const sum = await ok('blender_scene', { path: 'models/scene.blend' })
  assert.match(sum, /cena Scene \(ativa\) · EEVEE · 1920x1080@100% · 24 fps · frames 1-250 · camera Camera · 7 objetos/)
  assert.match(sum, /Props \[2 direto, 2 total\]/)
  assert.match(sum, /imagens 2 \(AUSENTES 1\) · bibliotecas 1 \(AUSENTES 1\)/)
  assert.match(sum, /\nCrate · MESH · Props · v8 f6 t12 · dim 4x2x2 · mods bevel · mats Wood · escala \(2, 1, 1\)\n Crate\.001 · MESH/)
  assert.doesNotMatch(sum, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
  const again = await call('blender_scene', { path: 'models/scene.blend' })
  assert.match(again.text, / · cache/)

  const obj = await ok('blender_scene', { path: 'models/scene.blend', mode: 'object', object: 'Crate' })
  assert.match(obj, /escala \(2, 1, 1\) \[nao uniforme, nao aplicada\]/)
  assert.match(obj, /Bevel BEVEL: segments=3\n/)
  assert.match(obj, /faces 6 \(tris 0, quads 6, ngons 0\)/); assert.match(obj, /propriedades custom: game_id=7/); assert.match(obj, /filhos \(1\): Crate\.001/)
  assert.match(await ok('blender_scene', { path: 'models/scene.blend', mode: 'object', object: 'Crate.001' }), /apos modificadores \(viewport\): v26 · faces 24 · triangulos 48\n.*\n?shape keys \(2\): Basis, Squash/)
  assert.match((await call('blender_scene', { path: 'models/scene.blend', mode: 'object', object: 'crate' })).text, /^Erro: Objeto "crate" inexistente\. Parecidos: Crate/)

  const mats = await ok('blender_scene', { path: 'models/scene.blend', mode: 'materials' })
  assert.match(mats, /Wood · usuarios 2 · .*bsdf base<-tex_image .*normal<-normal_map · imagens wood\[AUSENTE\],wood_n/)
  assert.match(mats, /Unused · usuarios 1 \(fake\) · SEM OBJETOS/)
  const imgs = await ok('blender_scene', { path: 'models/scene.blend', mode: 'images' })
  assert.match(imgs, /wood · FILE · models\/textures\/wood_missing\.png · AUSENTE · sRGB/)
  assert.match(imgs, /wood_n · FILE · models\/textures\/wood_n\.png · ok · 256x128 · sRGB/)
  assert.match(await ok('blender_scene', { path: 'models/scene.blend', mode: 'libraries' }), /lib\.blend · models\/lib\.blend · AUSENTE · itens: objects 1/)

  const audit = await ok('blender_scene', { path: 'models/scene.blend', mode: 'audit' })
  for (const re of [/\[ERRO\] imagens ausentes \(1\): wood -> models\/textures\/wood_missing\.png/, /\[ERRO\] bibliotecas ausentes \(1\)/, /\[AVISO\] escala negativa .*Disc/,
    /\[AVISO\] escala nao uniforme \(1\): Crate/, /\[AVISO\] malhas com n-gons .*\(1\): Disc: 1 n-gon/, /\[AVISO\] malhas sem faces \(1\): Wire/, /\[AVISO\] slots de material vazios \(1\): Slotty\[0\]/,
    /\[AVISO\] malhas sem material \(1\): Disc/, /\[AVISO\] shape keys \+ modificadores .*Crate\.001/, /wood_n sRGB em Normal Map/, /\[INFO\] materiais sem objetos .*Unused/, /nao cobre:/])
    assert.match(audit, re)
  assert.ok(audit.indexOf('[ERRO]') < audit.indexOf('[AVISO]') && audit.indexOf('[AVISO]') < audit.indexOf('[INFO]'))
  assert.match(await ok('blender_scene', { path: 'models/scene.blend', mode: 'audit', object: 'Disc' }), /filtro "Disc": 1 objetos/)
  assert.match((await call('blender_scene', { path: 'models/scene.blend', scene: 'Nope' })).text, /Cena "Nope" inexistente\. Cenas: Scene/)

  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(scenePath)).digest('hex'), sceneHash, '.blend intacto')
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'models')).filter(f => /\.blend\d$/.test(f)), ['scene.blend1'], 'nenhum backup novo')
})

test('cena grande: séries agregadas, lista limitada com dica, filtro glob e paginação', e2e, async () => {
  const t = await call('blender_scene', { path: 'models/forest.blend' }, ctx, 50_000)
  assert.equal(t.isError, false, t.text)
  assert.match(t.text, /tipos: MESH 3400/); assert.match(t.text, /malhas mais pesadas: malha M t3 x3400 obj \(Tree0000\.\.\.\)/)
  assert.match(t.text, /Tree\* · 3000 x MESH · malha M compartilhada · t9000 total/)
  assert.match(t.text, /objetos \(400 fora das series; arvore por parentesco; primeiros 150\)/); assert.match(t.text, /\+250 objetos; use object=<glob>/)
  assert.ok(t.text.length < 12_000, String(t.text.length))
  const first = await ok('blender_scene', { path: 'models/forest.blend' }, ctx, 4000)
  assert.ok(first.length <= 4000); assert.match(first, /próximo offset \d+/); assert.match(first, /Tree\* · 3000 x MESH/)
  assert.match(await ok('blender_scene', { path: 'models/forest.blend', object: 'Tree001*' }), /objetos com "Tree001\*" \(10 de 3400\)/)
  const audit = await ok('blender_scene', { path: 'models/forest.blend', mode: 'audit' })
  assert.match(audit, /malha M: 1 n-gon\(s\) em 3400 objetos \(Tree\* \(3000\), P0X, P1X\)/); assert.match(audit, /malhas sem material \(3400\): Tree\* \(3000\); P0X; .*\+393 mais\n/)
  assert.ok(audit.length < 2000, String(audit.length))
})

test('cache invalida quando uma textura externa aparece; arquivo ilegível e nomes forjados', e2e, async () => {
  const before = await ok('blender_scene', { path: 'models/scene.blend', mode: 'audit' })
  assert.match(before, /imagens ausentes/)
  const tex = path.join(cwd, 'models', 'textures', 'wood_missing.png')
  fs.copyFileSync(path.join(cwd, 'models', 'textures', 'wood_n.png'), tex)
  try {
    const after = await ok('blender_scene', { path: 'models/scene.blend', mode: 'audit' })
    assert.doesNotMatch(after, /imagens ausentes| · cache/)
  } finally { fs.rmSync(tex) }
  assert.match((await call('blender_scene', { path: 'models/fake.blend' })).text, /^Erro: .*(não abriu|não produziu)/)
  const evil = await ok('blender_scene', { path: 'models/evil.blend' })
  assert.match(evil, /Evil\?\[ERRO\] forjado · EMPTY/); assert.doesNotMatch(evil, /\n\[ERRO\]/)
})

test('cancelamento pelo cliente encerra a execução', e2e, async () => {
  const ac = new AbortController(); setTimeout(() => ac.abort(), 50)
  const r = await call('blender_scene', { path: 'models/forest.blend', mode: 'images' }, ctx, 8000, ac.signal)
  assert.equal(r.isError, true); assert.match(r.text, /cancelada/)
})

test('blender_diagnostics em log real de script que falha: traceback com arquivo/linha, caminhos externos ocultos', e2e, async () => {
  fs.mkdirSync(path.join(cwd, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'tools', 'fix.py'), 'import bpy\nprint("ok")\nbpy.data.objects["Missing"].scale = (1, 1, 1)\n')
  const r = spawnSync(EXE, ['-b', '--factory-startup', '-Y', scenePath, '--python', path.join(cwd, 'tools', 'fix.py')], { encoding: 'utf8', timeout: 60_000, cwd })
  fs.writeFileSync(path.join(cwd, 'logs', 'fix.log'), r.stdout + r.stderr)
  const t = await ok('blender_diagnostics', { path: 'logs/fix.log' })
  assert.match(t, /\[error\] KeyError: .*Missing.* · tools\/fix\.py:3 · repetições 1/)
  assert.match(t, /\[warning\] .*Unable to open/)
  assert.match(t, /\[info\] Arquivo aberto · models\/scene\.blend/)
  assert.doesNotMatch(t, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
  assert.match(await ok('blender_diagnostics', { path: 'logs/fix.log', detail: 0 }), /"outputLines"/)
  const raw = await ok('blender_diagnostics', { path: 'logs/fix.log', raw: true }, ctx, 1000)
  assert.ok(raw.length <= 1000); assert.match(raw, /Blender \d/)
  assert.equal((await call('blender_diagnostics', { path: 'models/scene.blend' })).isError, true)
  assert.equal((await call('blender_diagnostics', { path: 'logs/fix.log', raw: true, detail: 0 })).isError, true)
})

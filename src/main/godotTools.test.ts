import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openGrant } from './consent.ts'
import { openDb } from './db.ts'
import { GODOT_TOOLS, callGodotTool } from './godotTools.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import type { ToolCtx } from './taskContext.ts'
import { createTask } from './tasks.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-godot-tools-'))
const cwd = path.join(root, 'project'), outside = path.join(root, 'outside')
fs.mkdirSync(path.join(cwd, 'scenes'), { recursive: true }); fs.mkdirSync(path.join(cwd, 'scripts')); fs.mkdirSync(outside)
fs.writeFileSync(path.join(cwd, 'scripts', 'player.gd'), 'extends CharacterBody2D\n')
fs.writeFileSync(path.join(cwd, 'project.godot'), `config_version=5
[application]
config/name="Game"
config/features=PackedStringArray("4.5", "GL Compatibility")
run/main_scene="res://scenes/main.tscn"
[autoload]
Player="*res://scripts/player.gd"
`)
fs.writeFileSync(path.join(cwd, 'export_presets.cfg'), `[preset.0]
name="Windows"
platform="Windows Desktop"
export_path="build/game.exe"
[preset.0.options]
binary_format/embed_pck=false
`)
const longValue = `PackedInt32Array(${Array.from({ length: 5000 }, (_, i) => i).join(', ')})`
const sceneText = `[gd_scene load_steps=4 format=3]

[ext_resource type="Script" path="res://scripts/player.gd" id="1_player"]
[ext_resource type="PackedScene" path="res://scenes/inherited.tscn" id="2_scene"]
[sub_resource type="Resource" id="Resource_1"]
values = ${longValue}

[node name="Main" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]
script = ExtResource("1_player")
speed = 250.0
dialogue = "first line
[node name=\\"not_a_node\\" parent=\\".\\"]
last line"

[node name="Label" type="Label" parent="Player"]
text = "caption"

[node name="Enemy" parent="." instance=ExtResource("2_scene")]

[connection signal="ready" from="Player" to="." method="_ready"]
`
const scenePath = path.join(cwd, 'scenes', 'main.tscn')
fs.writeFileSync(scenePath, sceneText)
const db = openDb(path.join(root, 'test.db')), taskId = createTask(db, cwd, 'Godot')
const group = { id: 'godot', name: 'Godot', color: '#88aabb', games: [cwd], open: true, godot: { enabled: true, executable: 'godot' } }
const setGroups = (groups: any[] = [group]) => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('projectGroups',?)").run(JSON.stringify(groups))
setGroups()
const context = (scope: string[] = [], role: 'parent' | 'child' = 'child'): ToolCtx => {
  const lineage = `del:${taskId}`
  return { taskId, lineage, auth: openGrant(db, { taskId, recipient: { logicalId: lineage, provider: 'codex', profile: '', workspace: cwd, scope } }), cwd, scope, role }
}
const ctx = context()
const call = (name: string, args: any = {}, c = ctx, organizerId = 'godot', chars = 6000) => callGodotTool(db, { ...DEFAULT_LIMITS, queryChars: chars }, c, organizerId, name, args)
const content = (response: string) => response.split('\n').slice(2).join('\n')
const hash = (response: string) => /hash ([a-f0-9]{64})/.exec(response)![1]
const next = (response: string) => /próximo offset (\d+)/.exec(response)?.[1]

test.after(() => {
  db.close()
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('gpd-godot-tools-'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('três esquemas pequenos, sob demanda e sem ações; projeto retorna só metadados úteis', () => {
  assert.deepEqual(GODOT_TOOLS.map(t => t.name), ['godot_project', 'godot_scene', 'godot_diagnostics'])
  assert.ok(JSON.stringify(GODOT_TOOLS).length < 2600)
  const r = call('godot_project', {}, context([], 'parent'))
  assert.equal(r.isError, false, r.text)
  assert.match(r.text, /"version": "4\.5"/); assert.match(r.text, /res:\/\/scenes\/main\.tscn/)
  assert.match(r.text, /"embeddedPck": false/)
  assert.doesNotMatch(r.text, /config\/name|GodotConfig|executable/)
  assert.equal(call('godot_project', { game: cwd }).isError, true)
  assert.equal(call('godot_run').isError, true)
})

test('revalida organizador ativo, mesmo grupo da invocação, tarefa, workspace e escopo do grant', () => {
  const good = call('godot_project')
  assert.equal(good.isError, false, good.text)
  try {
    setGroups([{ ...group, godot: { ...group.godot, enabled: false } }])
    assert.equal(call('godot_project').isError, true)
    setGroups([{ ...group, id: 'other-organizer' }])
    assert.equal(call('godot_project').isError, true)
    setGroups([group, { ...group, id: 'duplicate' }])
    assert.equal(call('godot_project').isError, true)
  } finally { setGroups() }
  assert.equal(call('godot_project', {}, ctx, 'other-organizer').isError, true)
  assert.equal(call('godot_project', {}, { ...ctx, taskId: taskId + 1 }).isError, true)
  assert.equal(call('godot_project', {}, { ...ctx, lineage: 'del:other' }).isError, true)
  assert.equal(call('godot_project', {}, { ...ctx, cwd: outside }).isError, true)
  const outsideGrant: ToolCtx = { ...ctx, cwd: outside, auth: openGrant(db, { taskId, recipient: { ...ctx.auth.recipient, workspace: outside } }) }
  assert.match(call('godot_project', {}, outsideGrant).text, /Workspace incompatível com a tarefa/)
  try {
    db.prepare('UPDATE tasks SET worktree=? WHERE id=?').run(outside, taskId)
    assert.match(call('godot_project').text, /Workspace incompatível com a tarefa/)
  } finally { db.prepare('UPDATE tasks SET worktree=NULL WHERE id=?').run(taskId) }
  assert.equal(call('godot_project', {}, { ...ctx, scope: ['scenes'] }).isError, true)
  const scoped = context(['project.godot', 'scenes', 'scripts'])
  assert.equal(call('godot_project', {}, { ...scoped, scope: ['scripts/', 'scenes', './project.godot'] }).isError, false)
})

test('índice por subárvore não lê valores enormes; preserva linhas, scripts, conexões e limitações', () => {
  const all = call('godot_scene', { path: 'scenes/main.tscn' })
  assert.equal(all.isError, false, all.text)
  assert.match(all.text, /4 nó\(s\), 1 recurso\(s\), 2 referência\(s\)/)
  assert.match(all.text, /nó Player\/Label/)
  assert.match(all.text, /referência 1_player.*res:\/\/scripts\/player\.gd/)
  assert.match(all.text, /conexão Player.ready/)
  assert.match(all.text, /instâncias\/defaults não resolvidos/)
  assert.ok(all.text.length < sceneText.length / 8, `${all.text.length} chars versus ${sceneText.length}`)
  const branch = call('godot_scene', { path: 'scenes/main.tscn', node: 'Player' })
  assert.match(branch.text, /nó Player\/Label/); assert.doesNotMatch(branch.text, /nó Enemy|referência 2_scene/)
  assert.match(branch.text, /script ExtResource\("1_player"\)/)
  const exact = call('godot_scene', { path: 'scenes/main.tscn', node: 'Player', property: 'speed' })
  assert.match(exact.text, /250\.0/); assert.doesNotMatch(exact.text, /caption/)
  const multiline = call('godot_scene', { path: 'scenes/main.tscn', node: 'Player', property: 'dialogue' })
  assert.match(multiline.text, /first line\n\[node name=\\"not_a_node\\"/)
  assert.equal(call('godot_scene', { path: 'scenes/main.tscn', node: 'Enemy', property: 'speed' }).isError, true)
  assert.equal(call('godot_scene', { path: 'scenes/main.tscn', property: 'speed' }).isError, true)
})

test('valores brutos grandes são recuperáveis por páginas exatas, hash detecta mudança de fonte ou consulta', () => {
  const args = { path: 'scenes/main.tscn', resource: 'Resource_1', property: 'values' }
  let r = call('godot_scene', args, ctx, 'godot', 1000), joined = content(r.text)
  assert.equal(r.isError, false, r.text); const firstHash = hash(r.text)
  let iterations = 0
  while (next(r.text)) {
    const offset = Number(next(r.text))
    r = call('godot_scene', { ...args, offset, hash: firstHash }, ctx, 'godot', 1000)
    assert.equal(r.isError, false, r.text); assert.ok(r.text.length <= 1000)
    joined += content(r.text); assert.ok(++iterations < 100)
  }
  assert.ok(joined.includes(longValue), 'nenhum caractere do valor foi perdido')
  assert.equal(call('godot_scene', { ...args, offset: 10 }).isError, true)
  assert.equal(call('godot_scene', { path: args.path, node: '.', offset: 10, hash: firstHash }).isError, true)
  try {
    fs.writeFileSync(scenePath, sceneText.replace('speed = 250.0', 'speed = 300.0'))
    assert.equal(call('godot_scene', { ...args, offset: 10, hash: firstHash }).isError, true)
  } finally { fs.writeFileSync(scenePath, sceneText) }
  assert.ok(call('godot_scene', { path: args.path }, ctx, 'godot', 500).text.length <= 500)
})

test('recurso .tres, binário e sintaxe incompleta têm comportamento explícito', () => {
  fs.writeFileSync(path.join(cwd, 'data.tres'), '[gd_resource type="Resource" format=3]\n[resource]\nname = "data"\n')
  const r = call('godot_scene', { path: 'data.tres', resource: 'main', property: 'name' })
  assert.equal(r.isError, false, r.text); assert.match(r.text, /"data"/)
  fs.writeFileSync(path.join(cwd, 'binary.tscn'), Buffer.from([0, 1, 2]))
  assert.equal(call('godot_scene', { path: 'binary.tscn' }).isError, true)
  fs.writeFileSync(path.join(cwd, 'broken.tscn'), '[gd_scene format=3]\n[node name="Root" type="Node"]\nvalues = [1,\n')
  assert.match(call('godot_scene', { path: 'broken.tscn' }).text, /não interpretado/)
})

test('escopo e caminhos reais barram traversal, junction externa e referências fora do escopo', () => {
  const scoped = context(['scenes/main.tscn'])
  const r = call('godot_scene', { path: 'scenes/main.tscn' }, scoped)
  assert.equal(r.isError, false, r.text)
  assert.doesNotMatch(r.text, /scripts\/player\.gd|scenes\/inherited\.tscn/)
  assert.match(r.text, /referência fora do escopo/)
  assert.equal(call('godot_project', {}, scoped).isError, true)
  for (const p of ['../outside/private.tscn', scenePath, 'res://scenes/main.tscn', 'user://private.log', '.git/config']) {
    assert.equal(call('godot_scene', { path: p }).isError, true, p)
  }
  fs.writeFileSync(path.join(outside, 'private.tscn'), '[gd_scene format=3]\n[node name="SECRET" type="Node"]\n')
  const link = path.join(cwd, 'linked')
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const linked = call('godot_scene', { path: 'linked/private.tscn' })
  assert.equal(linked.isError, true); assert.doesNotMatch(linked.text, /SECRET/)
})

test('diagnósticos consultam só log explícito, agrupam repetição e mantêm detalhes e linhas de origem', () => {
  const log = 'Godot Engine v4.5.stable\n' + Array.from({ length: 1000 }, () => 'SCRIPT ERROR: Parse Error: Unexpected identifier.\n   at: GDScript::reload (res://scripts/player.gd:9)\n').join('') + 'WARNING: scene warning\n'
  fs.writeFileSync(path.join(cwd, 'godot.log'), log)
  db.prepare("INSERT INTO messages(chat_key,role,text,task_id) VALUES(?,'assistant','HISTORY_SECRET',?)").run(`task:${taskId}`, taskId)
  const r = call('godot_diagnostics', { path: 'godot.log' })
  assert.equal(r.isError, false, r.text)
  assert.match(r.text, /repetições 1000/); assert.match(r.text, /res:\/\/scripts\/player\.gd:9/)
  assert.ok(r.text.length < log.length / 50, `${r.text.length} chars versus ${log.length}`)
  assert.doesNotMatch(r.text, /HISTORY_SECRET/)
  const detail = call('godot_diagnostics', { path: 'godot.log', detail: 0 })
  assert.match(detail.text, /"outputLines"/); assert.match(detail.text, /"count": 1000/)
  const raw = call('godot_diagnostics', { path: 'godot.log', raw: true }, ctx, 'godot', 1000)
  assert.ok(next(raw.text)); assert.ok(raw.text.length <= 1000); assert.match(raw.text, /Godot Engine/)
  assert.equal(call('godot_diagnostics', { commandRunId: 1 }).isError, true)
  assert.equal(call('godot_diagnostics', { path: 'project.godot', raw: true }).isError, true)
  assert.equal(call('godot_diagnostics', { path: 'godot.log', detail: 0, raw: true }).isError, true)
  const scoped = context(['godot.log'])
  assert.doesNotMatch(call('godot_diagnostics', { path: 'godot.log' }, scoped).text, /scripts\/player\.gd/)
  assert.doesNotMatch(call('godot_diagnostics', { path: 'godot.log', raw: true }, scoped).text, /scripts\/player\.gd/)
})

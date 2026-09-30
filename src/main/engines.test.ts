import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import { engineGrants, engineOrganizer, engineProjectAt, hasBlendFiles, sameGrants } from './engines.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-engines-'))
const unity = path.join(root, 'unity'), blend = path.join(root, 'art'), plain = path.join(root, 'plain')
fs.mkdirSync(path.join(unity, 'ProjectSettings'), { recursive: true }); fs.mkdirSync(path.join(unity, 'Assets'))
fs.writeFileSync(path.join(unity, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.20f1\n')
fs.mkdirSync(path.join(blend, 'models', 'props'), { recursive: true }); fs.writeFileSync(path.join(blend, 'models', 'props', 'crate.blend'), 'BLENDER-v400')
fs.mkdirSync(path.join(plain, 'node_modules', 'x'), { recursive: true }); fs.writeFileSync(path.join(plain, 'node_modules', 'x', 'hidden.blend'), '')
const db = openDb(path.join(root, 'test.db'))
const setGroups = (groups: unknown[]) => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('projectGroups',?)").run(JSON.stringify(groups))

test('organizador concede cada engine separadamente; executável vazio usa o padrão da engine', () => {
  setGroups([{ id: 'jogos', name: 'Jogos', games: [unity, blend, plain], unity: { enabled: true, executable: '' }, blender: { enabled: true, executable: ' /opt/blender/blender ' }, godot: { enabled: false, executable: 'godot' } }])
  assert.deepEqual(engineOrganizer(db, unity, 'unity'), { id: 'jogos', name: 'Jogos', config: { enabled: true, executable: 'unity' } })
  assert.equal(engineOrganizer(db, unity, 'blender')?.config.executable, '/opt/blender/blender')
  assert.equal(engineOrganizer(db, unity, 'godot'), null) // desativado
  assert.equal(engineOrganizer(db, path.join(root, 'fora'), 'unity'), null) // projeto fora do organizador
  setGroups([{ id: 'a', name: 'A', games: [unity], unity: { enabled: true, executable: '' } }, { id: 'b', name: 'B', games: [unity], unity: { enabled: true, executable: '' } }])
  assert.equal(engineOrganizer(db, unity, 'unity'), null) // ambíguo: dois organizadores com a mesma pasta
  setGroups([{ id: 'j', name: 'J', games: [unity], unity: { enabled: true, executable: 'unity\n--x' } }])
  assert.equal(engineOrganizer(db, unity, 'unity'), null) // executável inválido não concede
})

test('detecção pela pasta: Unity por ProjectVersion + Assets; Blender por .blend fora de pastas de dependência', () => {
  assert.equal(engineProjectAt('unity', unity), true); assert.equal(engineProjectAt('unity', blend), false)
  assert.equal(engineProjectAt('blender', blend), true); assert.equal(hasBlendFiles(plain), false)
  assert.equal(hasBlendFiles(blend, 5000, 1), false) // profundidade limitada
})

test('concessão = engine ativa no organizador E presente na pasta', () => {
  setGroups([{ id: 'jogos', name: 'Jogos', games: [unity, blend], unity: { enabled: true, executable: '' }, blender: { enabled: true, executable: '' } }])
  assert.deepEqual(engineGrants(db, unity, unity), { unity: 'jogos' })
  assert.deepEqual(engineGrants(db, blend, blend), { blender: 'jogos' })
  assert.deepEqual(engineGrants(db, plain, plain), {})
  assert.ok(sameGrants({ unity: 'jogos' }, { unity: 'jogos' }) && !sameGrants({ unity: 'jogos' }, {}) && sameGrants(undefined, {}))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createTask } from './tasks.ts'
import { projectCommands, saveCommands, type ProjectCommand } from './commands.ts'
import { godotBuildFile, godotCommandError, prepareGodot, validatePreparedGodot } from './godotFlow.ts'

const config = 'config_version=5\n[application]\nconfig/features=PackedStringArray("4.4", "GL Compatibility")\nrun/main_scene="res://main.tscn"\n'
const presets = '[preset.0]\nname="Windows Desktop"\nplatform="Windows Desktop"\n[preset.0.options]\nbinary_format/embed_pck=true\n'
const capabilities = ['--headless', '--path', '--import', '--check-only', '--script', '--export-release', '--export-debug', '--editor', '--quit', '--log-file']
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-godot-flow-')), db = new DatabaseSync(':memory:'); migrate(db)
  const put = (rel: string, text: string) => { const file = path.join(cwd, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  put('project.godot', config); put('export_presets.cfg', presets); put('main.tscn', '[gd_scene format=3]\n[node name="Main" type="Node"]\n'); put('state.gd', 'extends Node\n')
  put('bin/editor', 'fixture executable identity'); fs.mkdirSync(path.join(cwd, 'build'))
  const executable = path.join(cwd, 'bin/editor'), task = createTask(db, cwd), probe = { executable, version: '4.4.stable', major: 4, capabilities }
  const group = { id: 'example', name: 'Examples', games: [cwd], godot: { enabled: true, executable } }
  const groups = (values: unknown) => db.prepare("INSERT OR REPLACE INTO settings VALUES ('projectGroups',?)").run(JSON.stringify(values))
  groups([group])
  const prepare = (action: string, args: unknown = {}) => prepareGodot(db, cwd, cwd, action, args, probe)
  const run = (command: ProjectCommand, changes: { status?: string; error?: string; truncated?: number; output?: string } = {}) => Number(db.prepare('INSERT INTO command_runs(task_id,workspace,name,program,args,status,exit_code,error,truncated,output) VALUES (?,?,?,?,?,?,?,?,?,?)').run(task, cwd, command.name, command.program, JSON.stringify(command.args), changes.status ?? 'completed', 0, changes.error ?? null, changes.truncated ?? 0, changes.output ?? '').lastInsertRowid)
  const close = () => { db.close(); assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir())); assert.match(path.basename(cwd), /^gpd-godot-flow-/); assert.equal(fs.lstatSync(cwd).isSymbolicLink(), false); fs.rmSync(cwd, { recursive: true, force: true }) }
  return { cwd, db, put, executable, probe, group, groups, task, prepare, run, close }
}

test('Godot flow: preparação preserva comandos manuais e receitas são atômicas dentro de transações', () => {
  const f = fixture(), manual: ProjectCommand = { name: 'Teste local', purpose: 'test', program: process.execPath, args: ['--version'] }
  try {
    saveCommands(f.db, f.cwd, [manual]); f.db.exec('BEGIN')
    const command = f.prepare('import'); assert.deepEqual(projectCommands(f.db, f.cwd), [manual, command]); validatePreparedGodot(f.db, f.cwd, f.cwd, command)
    f.db.exec('ROLLBACK'); assert.deepEqual(projectCommands(f.db, f.cwd), [manual])
    assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /Prepare/)
    f.db.exec("CREATE TRIGGER reject_godot BEFORE INSERT ON settings WHEN NEW.key LIKE 'godotPlan:%' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
    assert.throws(() => f.prepare('import'), /fixture failure/); assert.deepEqual(projectCommands(f.db, f.cwd), [manual])
    f.db.exec('DROP TRIGGER reject_godot')
    saveCommands(f.db, f.cwd, [manual, { ...manual, name: command.name }]); assert.throws(() => f.prepare('import'), /manual/)
    saveCommands(f.db, f.cwd, [manual]); const original = f.prepare('import')
    saveCommands(f.db, f.cwd, [manual, { ...original, args: ['--version'] }]); assert.throws(() => f.prepare('import'), /manual/)
    assert.deepEqual(projectCommands(f.db, f.cwd)[0], manual)
    saveCommands(f.db, f.cwd, Array.from({ length: 12 }, (_, i) => ({ ...manual, name: `Command ${i}` })))
    assert.throws(() => f.prepare('check', { script: 'state.gd' }), /12 comandos/); assert.equal(projectCommands(f.db, f.cwd).length, 12)
  } finally { f.close() }
})

test('Godot flow: opt-in, identidade de organizador/binário e caminhos são revalidados antes do spawn', () => {
  const f = fixture()
  try {
    const command = f.prepare('check', { script: 'state.gd' }); validatePreparedGodot(f.db, f.cwd, f.cwd, command)
    assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, { ...command, args: ['--version'] }), /Receita/)
    f.groups([{ ...f.group, godot: { enabled: false, executable: f.executable } }]); assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /organizador ativo/); assert.throws(() => f.prepare('run'), /Ative/)
    f.groups([{ ...f.group, id: 'another' }]); assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /organizador ativo/)
    f.groups([{ ...f.group, godot: { enabled: true, executable: process.execPath } }]); assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /configuração/)
    f.groups([f.group]); fs.unlinkSync(path.join(f.cwd, 'state.gd')); assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /ENOENT/)
    f.put('state.gd', 'extends Node\n'); f.put('bin/editor', 'replacement executable identity'); assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /executável Godot mudou/)
    validatePreparedGodot(f.db, f.cwd, f.cwd, { name: 'Manual', purpose: 'run', program: process.execPath, args: [] })
    assert.throws(() => f.prepare('invalid'), /Ação/); assert.throws(() => f.prepare('run', []), /Opções/); assert.throws(() => f.prepare('run', { script: 1 }), /Opções/); assert.throws(() => f.prepare('run', { unknown: true }), /Opções/)
    assert.throws(() => prepareGodot(f.db, f.cwd, f.cwd, 'import', {}, { ...f.probe, major: 3 }), /Godot 4/)
    assert.throws(() => prepareGodot(f.db, f.cwd, f.cwd, 'import', {}, { ...f.probe, capabilities: [] }), /recursos/)
  } finally { f.close() }
})

test('Godot flow: exportação e log ocupado após preparar impedem executar sem sobrescrever', () => {
  const f = fixture()
  try {
    const command = f.prepare('export', { preset: 'Windows Desktop', output: 'build/game.exe', log: 'export.log' })
    validatePreparedGodot(f.db, f.cwd, f.cwd, command)
    f.put('export.log', 'preserve'); assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /log já existe/); assert.equal(fs.readFileSync(path.join(f.cwd, 'export.log'), 'utf8'), 'preserve')
    fs.unlinkSync(path.join(f.cwd, 'export.log')); f.put('build/game.exe', 'preserve'); assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /Destino já existe/)
    assert.equal(fs.readFileSync(path.join(f.cwd, 'build/game.exe'), 'utf8'), 'preserve')
  } finally { f.close() }
})

test('Godot flow: receita preparada em outra pasta exige preparação explícita mesmo com argumentos iguais', () => {
  const f = fixture()
  try {
    const args = { preset: 'Windows Desktop', output: 'build/game.exe' }, command = f.prepare('export', args)
    const cwd = path.join(f.cwd, '.worktrees', 'feature')
    fs.mkdirSync(path.join(cwd, 'build'), { recursive: true })
    for (const file of ['project.godot', 'export_presets.cfg', 'main.tscn']) fs.copyFileSync(path.join(f.cwd, file), path.join(cwd, file))
    assert.throws(() => validatePreparedGodot(f.db, f.cwd, cwd, command), /Prepare o comando novamente na pasta atual/)
    const prepared = prepareGodot(f.db, f.cwd, cwd, 'export', args, f.probe)
    assert.deepEqual(prepared.args, command.args)
    validatePreparedGodot(f.db, f.cwd, cwd, prepared)
    assert.throws(() => validatePreparedGodot(f.db, f.cwd, f.cwd, command), /pasta atual/)
  } finally { f.close() }
})

test('Godot flow: erros com exit 0 e saída truncada recusam qualidade; outros comandos preservam comportamento', () => {
  const command: ProjectCommand = { name: 'Godot · Verificar script', purpose: 'test', program: 'godot', args: [] }
  assert.match(godotCommandError(command, 'SCRIPT ERROR: invalid\n at: reload (res://state.gd:9)', false)!, /1 erro/)
  assert.match(godotCommandError(command, 'ordinary output', true)!, /truncada/)
  assert.equal(godotCommandError(command, 'WARNING: warning', false), undefined)
  assert.equal(godotCommandError({ ...command, name: 'Manual' }, 'ERROR: failure', true), undefined)
})

test('Godot flow: build exige receita histórica, execução própria concluída e exportação completa de um arquivo', () => {
  const f = fixture()
  try {
    const command = f.prepare('export', { preset: 'Windows Desktop', output: 'build/game.exe' }), id = f.run(command)
    assert.throws(() => godotBuildFile(f.db, f.task, id, f.cwd), /ENOENT/)
    f.put('build/game.exe', 'snapshot bytes'); assert.equal(godotBuildFile(f.db, f.task, id, f.cwd), 'build/game.exe')
    f.put('build/game.pck', 'companion'); assert.throws(() => godotBuildFile(f.db, f.task, id, f.cwd), /arquivos auxiliares/); fs.unlinkSync(path.join(f.cwd, 'build/game.pck'))
    f.put('build/game.exe', ''); assert.throws(() => godotBuildFile(f.db, f.task, id, f.cwd), /vazio/); f.put('build/game.exe', 'snapshot bytes')
    for (const changes of [{ status: 'failed' }, { truncated: 1 }, { error: 'engine error' }, { output: 'ERROR: engine error' }]) assert.throws(() => godotBuildFile(f.db, f.task, f.run(command, changes), f.cwd))
    assert.throws(() => godotBuildFile(f.db, f.task + 1, id, f.cwd), /nesta tarefa/)
    assert.throws(() => godotBuildFile(f.db, f.task, f.run({ ...command, args: [...command.args, '--editor'] }), f.cwd), /receita/)
    fs.mkdirSync(path.join(f.cwd, 'build2')); f.prepare('export', { preset: 'Windows Desktop', output: 'build2/next.exe' })
    assert.equal(godotBuildFile(f.db, f.task, id, f.cwd), 'build/game.exe')
    f.db.prepare('UPDATE tasks SET worktree=? WHERE id=?').run(path.join(f.cwd, 'other'), f.task)
    assert.throws(() => godotBuildFile(f.db, f.task, id, f.cwd), /nesta tarefa/)
  } finally { f.close() }
})

test('Godot flow: log explicitamente configurado pode acompanhar o exe sem incorporar arquivos inesperados', () => {
  const f = fixture()
  try {
    const command = f.prepare('export', { preset: 'Windows Desktop', output: 'build/game.exe', log: 'build/export.log' }), id = f.run(command)
    f.put('build/game.exe', 'snapshot'); f.put('build/export.log', 'log')
    assert.equal(godotBuildFile(f.db, f.task, id, f.cwd), 'build/game.exe')
    f.put('build/unexpected.log', 'unknown'); assert.throws(() => godotBuildFile(f.db, f.task, id, f.cwd), /arquivos auxiliares/)
  } finally { f.close() }
})

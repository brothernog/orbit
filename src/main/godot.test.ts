import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { godotCommand, godotDiagnostics, godotOrganizer, godotProbe, godotProject } from './godot.ts'

const project = `; Engine configuration file.
config_version=5
[application]
config/name="Example"
config/features=PackedStringArray(
  "4.4", "GL Compatibility"
)
run/main_scene="res://scenes/main.tscn"
[autoload]
State="*res://scripts/state.gd"
`
const presets = `[preset.0]
name="Windows Desktop"
platform="Windows Desktop"
export_path="build/game.exe"
[preset.0.options]
binary_format/embed_pck=true
codesign/password="example-secret"
custom_template/release="/private-template"
`
function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-godot-'))
  const put = (f: string, text: string) => { const p = path.join(d, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
  put('project.godot', project); put('export_presets.cfg', presets)
  put('scenes/main.tscn', '[gd_scene format=3]\n[node name="Main" type="Node"]\n')
  put('scripts/state.gd', 'extends Node\n'); fs.mkdirSync(path.join(d, 'build'))
  return { d, put, close: () => { assert.equal(path.dirname(path.resolve(d)), path.resolve(os.tmpdir())); assert.match(path.basename(d), /^gpd-godot-/); assert.equal(fs.lstatSync(d).isSymbolicLink(), false); fs.rmSync(d, { recursive: true, force: true }) } }
}

test('Godot: metadados selecionados não incluem segredos/cache e respeitam escopo real', () => {
  const f = fixture()
  try {
    f.put('export_credentials.cfg', 'password="do-not-read"\n')
    f.put('.godot/uid_cache.bin', 'do-not-read')
    f.put('project.godot', project + '[rendering]\n' + Array.from({ length: 1000 }, (_, i) => `setting${i}="${'irrelevant'.repeat(10)}"`).join('\n'))
    const p = godotProject(f.d)
    assert.equal(p.configVersion, 5); assert.equal(p.version, '4.4'); assert.equal(p.language, 'GDScript'); assert.equal(p.supported, true)
    assert.deepEqual(p.autoloads, [{ name: 'State', path: 'res://scripts/state.gd', singleton: true }])
    assert.equal(p.mainScene, 'res://scenes/main.tscn'); assert.equal(p.presets[0].embeddedPck, true); assert.equal(p.presets[0].output, 'build/game.exe')
    assert.doesNotMatch(JSON.stringify(p), /secret|private-template|do-not-read|irrelevant/)
    assert.ok(JSON.stringify(p).length < fs.statSync(path.join(f.d, 'project.godot')).size / 20)
    assert.throws(() => godotProject(f.d, () => false), /escopo/)
    const scoped = godotProject(f.d, rel => rel === 'project.godot')
    assert.equal(scoped.mainScene, null); assert.deepEqual(scoped.autoloads, []); assert.deepEqual(scoped.presets, [])
    assert.match(scoped.warnings.join(' '), /escopo/)
    const onlyConfigs = godotProject(f.d, rel => ['project.godot', 'export_presets.cfg'].includes(rel))
    assert.equal(onlyConfigs.presets[0].output, null)
  } finally { f.close() }
})

test('Godot: UID, C#, formato incompleto e arquivo grande deixam limites explícitos', () => {
  const f = fixture()
  try {
    f.put('project.godot', project.replace('res://scenes/main.tscn', 'uid://example'))
    assert.equal(godotProject(f.d).mainScene, 'uid://example'); assert.match(godotProject(f.d).warnings.join(' '), /UID/)
    assert.deepEqual(godotCommand(f.d, 'godot', 'run').args, ['--path', '.'])
    f.put('project.godot', project.replace('"GL Compatibility"', '"C#"'))
    assert.equal(godotProject(f.d).supported, false); assert.equal(godotProject(f.d).language, 'C#')
    assert.throws(() => godotCommand(f.d, 'godot', 'import'), /GDScript/)
    f.put('project.godot', project + '[broken]\nvalue=PackedStringArray("open"\n')
    assert.throws(() => godotProject(f.d), /incompleto.*read_file_range/)
    f.put('project.godot', 'x'.repeat(4 * 1024 * 1024 + 1))
    assert.throws(() => godotProject(f.d), /4 MiB.*read_file_range/)
    f.put('project.godot', project.replace('PackedStringArray(\n  "4.4", "GL Compatibility"\n)', 'StringArray("4.4")'))
    const unknown = godotProject(f.d)
    assert.equal(unknown.supported, false); assert.match(unknown.warnings.join(' '), /config\/features.*não suportado/)
  } finally { f.close() }
})

test('Godot: alias de ConfigFile respeita escopo canônico e recusa credenciais/cache', t => {
  const f = fixture(), config = path.join(f.d, 'project.godot')
  try {
    f.put('private/project.godot', project)
    fs.unlinkSync(config)
    try { fs.symlinkSync(path.join(f.d, 'private/project.godot'), config, 'file') }
    catch (e: any) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Sistema não permite criar symlink de arquivo.'); return } throw e }
    assert.throws(() => godotProject(f.d, rel => rel === 'project.godot'), /escopo/)
    assert.equal(godotProject(f.d, rel => rel === 'private/project.godot').version, '4.4')
    for (const target of ['export_credentials.cfg', '.godot/project.godot']) {
      f.put(target, project)
      fs.unlinkSync(config); fs.symlinkSync(path.join(f.d, target), config, 'file')
      assert.throws(() => godotProject(f.d, () => true), /interno\/credencial/)
    }
  } finally { f.close() }
})

test('Godot: ferramentas dependem de um organizador ativo único, aliases e executável direto', () => {
  const f = fixture(), db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  const save = (groups: unknown) => db.prepare("INSERT OR REPLACE INTO settings VALUES ('projectGroups',?)").run(JSON.stringify(groups))
  const group = { id: 'g', name: 'Examples', games: [f.d], godot: { enabled: true, executable: 'godot' } }
  try {
    assert.equal(godotOrganizer(db, f.d), null)
    save([group]); assert.equal(godotOrganizer(db, process.platform === 'linux' ? f.d : f.d.toUpperCase())?.id, 'g') // Linux diferencia caixa: outra pasta
    save([{ ...group, godot: { enabled: true, executable: '  ' } }]); assert.equal(godotOrganizer(db, f.d)?.config.executable, 'godot')
    assert.equal(godotOrganizer(db, path.join(f.d, 'other')), null)
    save([{ ...group, godot: { enabled: false, executable: 'godot' } }]); assert.equal(godotOrganizer(db, f.d), null)
    save([group, { ...group, id: 'duplicate' }]); assert.equal(godotOrganizer(db, f.d), null)
    save([group, { ...group, games: [path.join(f.d, 'other')] }]); assert.equal(godotOrganizer(db, f.d), null)
    save([{ ...group, godot: { enabled: true, executable: 'cmd.exe' } }]); assert.equal(godotOrganizer(db, f.d), null)
    db.prepare("UPDATE settings SET value='invalid'").run(); assert.equal(godotOrganizer(db, f.d), null)
  } finally { db.close(); f.close() }
})

test('Godot: exportação recusa saída ocupada e dependências nativas sem sobrescrever arquivos', () => {
  const f = fixture(), args = { preset: 'Windows Desktop', output: 'build/new.exe' }
  try {
    f.put('build/library.dll', 'preserve')
    assert.throws(() => godotCommand(f.d, 'godot', 'export', args), /pasta de saída vazia/)
    assert.equal(fs.readFileSync(path.join(f.d, 'build/library.dll'), 'utf8'), 'preserve')
    fs.unlinkSync(path.join(f.d, 'build/library.dll'))
    for (const name of ['addons/native.gdextension', 'scripts/player.cs', 'addons/runtime.dll']) {
      f.put(name, 'external build dependency')
      assert.throws(() => godotCommand(f.d, 'godot', 'export', args), /extensões\/binários nativos/)
      fs.unlinkSync(path.join(f.d, name))
    }
    f.put('.godot/editor/editor.dll', 'cache not exported')
    f.put('ignored/.gdignore', ''); f.put('ignored/native.gdextension', 'ignored')
    assert.equal(godotCommand(f.d, 'godot', 'export', args).purpose, 'build')
  } finally { f.close() }
})

test('Godot: importação, parse de script e execução usam argumentos separados sem shell', () => {
  const f = fixture()
  try {
    assert.deepEqual(godotCommand(f.d, 'godot', 'import').args, ['--headless', '--path', '.', '--import'])
    const check = godotCommand(f.d, 'godot', 'check', { script: 'scripts/state.gd' })
    assert.equal(check.purpose, 'test'); assert.deepEqual(check.args, ['--headless', '--path', '.', '--check-only', '--script', 'res://scripts/state.gd'])
    assert.throws(() => godotCommand(f.d, 'godot', 'check'), /script.*gameplay/)
    assert.throws(() => godotCommand(f.d, 'godot', 'check', { script: '../state.gd' }), /fora/)
    assert.throws(() => godotCommand(f.d, 'godot', 'check', { script: '.godot/state.gd' }), /fora/)
    assert.throws(() => godotCommand(f.d, 'cmd.exe', 'run'), /shell/)
    assert.deepEqual(godotCommand(f.d, 'godot', 'run', { scene: 'res://scenes/main.tscn', headless: true }).args, ['--headless', '--path', '.', 'res://scenes/main.tscn'])
    assert.deepEqual(godotCommand(f.d, 'godot', 'editor', { scene: 'scenes/main.tscn' }).args, ['--path', '.', '--editor', 'res://scenes/main.tscn'])
    assert.throws(() => godotCommand(f.d, 'godot', 'run', { headless: 'true' as any }), /Opções/)
    f.put('project.godot', project.replace('run/main_scene="res://scenes/main.tscn"', ''))
    assert.throws(() => godotCommand(f.d, 'godot', 'run'), /cena principal/)
  } finally { f.close() }
})

test('Godot: exportação exige preset PCK embutido, destino novo e log explícito novo', () => {
  const f = fixture()
  try {
    const command = godotCommand(f.d, 'godot', 'export', { preset: 'Windows Desktop', output: 'build/new.exe', log: 'build/export.log' })
    assert.equal(command.purpose, 'build')
    assert.deepEqual(command.args, ['--headless', '--path', '.', '--export-release', 'Windows Desktop', 'build/new.exe', '--log-file', 'build/export.log'])
    assert.equal(godotCommand(f.d, 'godot', 'export', { preset: 'Windows Desktop', output: 'build/debug.exe', debug: true }).args[3], '--export-debug')
    for (const output of ['../game.exe', '.godot/game.exe', 'missing/game.exe', path.join(f.d, 'build/game.exe')]) assert.throws(() => godotCommand(f.d, 'godot', 'export', { preset: 'Windows Desktop', output }))
    f.put('build/existing.exe', 'preserve'); f.put('build/existing.log', 'preserve')
    assert.throws(() => godotCommand(f.d, 'godot', 'export', { preset: 'Windows Desktop', output: 'build/existing.exe' }), /já existe/)
    assert.throws(() => godotCommand(f.d, 'godot', 'run', { log: 'build/existing.log' }), /já existe/)
    assert.throws(() => godotCommand(f.d, 'godot', 'run', { log: '../outside.log' }), /relativo/)
    assert.throws(() => godotCommand(f.d, 'godot', 'export', { preset: 'missing', output: 'build/new.exe' }), /preset/)
    f.put('export_presets.cfg', presets.replace('embed_pck=true', 'embed_pck=false'))
    assert.throws(() => godotCommand(f.d, 'godot', 'export', { preset: 'Windows Desktop', output: 'build/new.exe' }), /Embed PCK/)
    f.put('export_presets.cfg', presets.replace('platform="Windows Desktop"', 'platform="Linux"'))
    assert.throws(() => godotCommand(f.d, 'godot', 'export', { preset: 'Windows Desktop', output: 'build/new.exe' }), /Windows Desktop/)
    assert.equal(fs.readFileSync(path.join(f.d, 'build/existing.exe'), 'utf8'), 'preserve')
  } finally { f.close() }
})

test('Godot: erros mantêm origem, linha e ocorrências sem esconder diagnóstico longo', () => {
  const diagnostic = 'SCRIPT ERROR: Parse Error: Unexpected token.\n  at: GDScript::reload (res://scripts/state.gd:7)'
  const output = `Godot Engine v4.4\n${diagnostic}\n${diagnostic}\nWARNING: A warning\n  at: init (scene/main.cpp:12)\nERROR: ${'long'.repeat(2000)}\n`
  const d = godotDiagnostics(output)
  assert.equal(d.errorCount, 3); assert.equal(d.warningCount, 1); assert.equal(d.items.length, 3)
  assert.equal(d.items[0].file, 'res://scripts/state.gd'); assert.equal(d.items[0].line, 7); assert.equal(d.items[0].count, 2)
  assert.deepEqual(d.items[0].outputLines, [2, 3, 4, 5]); assert.equal(d.items[2].message.length, 8000)
  assert.deepEqual(godotDiagnostics('ordinary output').items, [])
  assert.equal(godotDiagnostics('\x1b[31mERROR: bad\x1b[0m').errorCount, 1)
  assert.equal(godotDiagnostics('SCRIPT ERROR: Bad\n GDScript backtrace (most recent call first):\n [0]: _ready (res://scripts/state.gd:11)').items[0].line, 11)
})

test('Godot: probe recusa shell, executável ausente e versão sem recursos Godot 4', async () => {
  await assert.rejects(godotProbe('cmd.exe', process.cwd()), /shell/)
  await assert.rejects(godotProbe(path.join(os.tmpdir(), 'no-godot-editor.exe'), process.cwd()))
  await assert.rejects(godotProbe(process.execPath, process.cwd()), /Godot 4/)
})

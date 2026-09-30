import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createTask } from './tasks.ts'
import { WorkspaceGuard } from './delegation.ts'
import { createCommandService, listCommandRuns, projectCommands, saveCommands, type ProjectCommand } from './commands.ts'
import { blenderProbe } from './blender.ts'
import { blenderCommand, blenderOutputs } from './blenderFlow.ts'
import { engineCommandError, engineRecipe, prepareEngine, validatePreparedEngine } from './engineFlow.ts'

const HEADER = Buffer.from('BLENDER-v402REND')
function fixture(executable?: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-engine-flow-')), db = new DatabaseSync(':memory:'); migrate(db)
  const put = (rel: string, data: string | Buffer) => { const file = path.join(cwd, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }
  put('models/a.blend', HEADER); put('tools/fix.py', 'import bpy\nprint("ok")\n'); put('bin/blender', 'fixture executable identity'); fs.mkdirSync(path.join(cwd, 'renders')); fs.mkdirSync(path.join(cwd, 'out'))
  const exe = executable ?? path.join(cwd, 'bin/blender'), task = createTask(db, cwd), probe = { exe, version: '4.0.2' }
  const group = { id: 'art', name: 'Arte', games: [cwd], blender: { enabled: true, executable: exe } }
  const groups = (values: unknown) => db.prepare("INSERT OR REPLACE INTO settings VALUES ('projectGroups',?)").run(JSON.stringify(values))
  groups([group])
  const prepare = (action: string, args: unknown = {}) => prepareEngine(db, cwd, cwd, 'blender', action, args, probe).command
  const validate = (command: ProjectCommand, dir = cwd) => validatePreparedEngine(db, cwd, dir, command)
  const close = () => { db.close(); assert.match(path.basename(cwd), /^gpd-engine-flow-/); fs.rmSync(cwd, { recursive: true, force: true }) }
  return { cwd, db, put, exe, probe, group, groups, task, prepare, validate, close }
}

test('Blender: argumentos exatos por ação e caminhos relativos, existentes e novos', () => {
  const f = fixture(), build = (action: string, args: object) => blenderCommand(f.cwd, f.exe, action, args)
  try {
    assert.deepEqual(build('render', { file: 'models/a.blend', output: 'renders/shot_', frame: 3 }).args, ['-b', '-Y', 'models/a.blend', '-o', 'renders/shot_####', '-F', 'PNG', '-x', '1', '-f', '3'])
    assert.deepEqual(build('render', { file: 'models\\a.blend', output: 'renders/' }).args.slice(3, 5), ['-o', 'renders/####'])
    assert.deepEqual(build('script', { file: 'models/a.blend', script: 'tools/fix.py' }).args, ['-b', '-Y', 'models/a.blend', '--python-exit-code', '1', '--python', 'tools/fix.py'])
    const exp = build('export', { file: 'models/a.blend', output: 'out/a "x".glb' })
    assert.deepEqual(exp.args.slice(0, 7), ['-b', '--factory-startup', '-Y', 'models/a.blend', '--python-exit-code', '1', '--python-expr'])
    assert.equal(exp.args[7], `import bpy; bpy.ops.export_scene.gltf(filepath="out/a \\"x\\".glb", export_format='GLB')`)
    assert.deepEqual(blenderOutputs(exp), ['out/a "x".glb'])
    assert.deepEqual(blenderOutputs(build('render', { file: 'models/a.blend', output: 'renders/s', frame: 12 })), ['renders/s0012.png'])
    const open = build('open', { file: 'models/a.blend' })
    assert.deepEqual([open.args, open.purpose, open.name], [['-Y', 'models/a.blend'], 'run', 'Blender · Abrir no Blender'])
    for (const file of ['../a.blend', '/etc/a.blend', 'C:/a.blend', '.git/a.blend', 'node_modules/x/a.blend', '-P.blend', 'models/missing.blend', 'tools/fix.py', 'models/a.blend\n', undefined])
      assert.throws(() => build('open', { file }), /arquivo \.blend|relativo|inexistente|fora/i, String(file))
    assert.throws(() => build('script', { file: 'models/a.blend', script: 'models/a.blend' }), /script/)
    assert.throws(() => build('script', { file: 'models/a.blend' }), /script/)
    assert.throws(() => build('render', { file: 'models/a.blend', output: 'renders/s_##' }), /#/)
    assert.throws(() => build('render', { file: 'models/a.blend', output: 'renders/{blend_name}' }), /#/)
    assert.throws(() => build('render', { file: 'models/a.blend', output: 'missing/s' }), /Crie a pasta/)
    assert.throws(() => build('render', { file: 'models/a.blend', output: 'renders/s', frame: -1 }), /Quadro/)
    f.put('renders/s0001.png', 'keep'); assert.throws(() => build('render', { file: 'models/a.blend', output: 'renders/s' }), /já existe/)
    assert.throws(() => build('export', { file: 'models/a.blend', output: 'out/a.gltf' }), /\.glb/)
    f.put('out/b.glb', 'keep'); assert.throws(() => build('export', { file: 'models/a.blend', output: 'out/b.glb' }), /já existe/)
    fs.symlinkSync(path.join(f.cwd, 'nowhere'), path.join(f.cwd, 'out/dangling.glb')); assert.throws(() => build('export', { file: 'models/a.blend', output: 'out/dangling.glb' }), /já existe/)
    f.put('.git/x.blend', HEADER); f.put('-P.blend', HEADER); fs.symlinkSync(path.join(f.cwd, '.git/x.blend'), path.join(f.cwd, 'models/git.blend')); fs.symlinkSync(path.join(f.cwd, '-P.blend'), path.join(f.cwd, 'models/opt.blend'))
    for (const file of ['models/git.blend', 'models/opt.blend']) assert.throws(() => build('open', { file }), /relativo/, file)
    fs.symlinkSync(os.tmpdir(), path.join(f.cwd, 'outside')); assert.throws(() => build('export', { file: 'models/a.blend', output: 'outside/x.glb' }), /fora/)
    assert.throws(() => build('bake', { file: 'models/a.blend' }), /Ação/)
  } finally { f.close() }
})

test('Engine flow: opções validadas, nome manual preservado e preparação atômica', () => {
  const f = fixture(), manual: ProjectCommand = { name: 'Teste local', purpose: 'test', program: process.execPath, args: ['--version'] }
  try {
    assert.throws(() => f.prepare('bake'), /Ação Blender/); assert.throws(() => f.prepare('open', []), /Opções/)
    assert.throws(() => f.prepare('open', { file: 'models/a.blend', extra: 1 }), /Opções/); assert.throws(() => f.prepare('render', { file: 'models/a.blend', output: 'renders/s', frame: 1.5 }), /Opções/)
    assert.throws(() => f.prepare('open', { file: 'models/a.blend', toString: 'x' }), /Opções/)
    assert.throws(() => prepareEngine(f.db, f.cwd, f.cwd, 'godot', 'open', {}, f.probe), /Engine inválida/)
    assert.throws(() => prepareEngine(f.db, f.cwd, f.cwd, 'unity', 'open', {}, f.probe), /Unity|Ative/)
    assert.equal(engineRecipe('unity').actions.includes('compile'), true)
    assert.throws(() => prepareEngine(f.db, f.cwd, f.cwd, 'blender', 'open', { file: 'models/a.blend' }, { exe: 'blender', version: '4.0' }), /Confira/)
    saveCommands(f.db, f.cwd, [manual]); f.db.exec('BEGIN')
    const command = f.prepare('open', { file: 'models/a.blend' }); assert.deepEqual(projectCommands(f.db, f.cwd), [manual, command]); f.validate(command)
    f.db.exec('ROLLBACK'); assert.deepEqual(projectCommands(f.db, f.cwd), [manual]); assert.throws(() => f.validate(command), /Prepare/)
    f.db.exec("CREATE TRIGGER reject BEFORE INSERT ON settings WHEN NEW.key LIKE 'enginePlan:%' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
    assert.throws(() => f.prepare('open', { file: 'models/a.blend' }), /fixture failure/); assert.deepEqual(projectCommands(f.db, f.cwd), [manual]); f.db.exec('DROP TRIGGER reject')
    saveCommands(f.db, f.cwd, [manual, { ...manual, name: 'blender · abrir no blender' }]); assert.throws(() => f.prepare('open', { file: 'models/a.blend' }), /manual/)
    saveCommands(f.db, f.cwd, [manual]); const original = f.prepare('open', { file: 'models/a.blend' })
    assert.deepEqual(f.prepare('open', { file: 'models/a.blend' }), original, 'preparar de novo substitui a própria receita')
    saveCommands(f.db, f.cwd, [manual, { ...original, args: ['--python-expr', 'x'] }]); assert.throws(() => f.prepare('open', { file: 'models/a.blend' }), /manual/)
    assert.equal(f.validate(manual), undefined)
  } finally { f.close() }
})

test('Engine flow: organizador, executável, binário, pasta, saída e script revisado são revalidados antes do spawn', () => {
  const f = fixture()
  try {
    const script = prepareEngine(f.db, f.cwd, f.cwd, 'blender', 'script', { file: 'models/a.blend', script: 'tools/fix.py' }, f.probe)
    assert.deepEqual(script.review, [{ file: 'tools/fix.py', text: 'import bpy\nprint("ok")\n', truncated: false }])
    const command = script.command; f.validate(command)
    assert.throws(() => f.validate({ ...command, args: [...command.args, '--'] }), /Receita/)
    f.groups([{ ...f.group, blender: { enabled: false, executable: f.exe } }]); assert.throws(() => f.validate(command), /organizador ativo/); assert.throws(() => f.prepare('open', { file: 'models/a.blend' }), /Ative Blender/)
    f.groups([{ ...f.group, id: 'other' }]); assert.throws(() => f.validate(command), /organizador ativo/)
    f.groups([{ ...f.group, blender: { enabled: true, executable: process.execPath } }]); assert.throws(() => f.validate(command), /configuração/)
    f.groups([f.group]); f.put('tools/fix.py', 'import os\nos.remove("x")\n'); assert.throws(() => f.validate(command), /script revisado mudou/)
    f.put('tools/fix.py', 'import bpy\nprint("ok")\n'); f.validate(command)
    fs.unlinkSync(path.join(f.cwd, 'tools/fix.py')); assert.throws(() => f.validate(command), /script/)
    f.put('tools/fix.py', 'import bpy\nprint("ok")\n'); f.put('bin/blender', 'replacement binary'); assert.throws(() => f.validate(command), /executável Blender mudou/)
    const render = prepareEngine(f.db, f.cwd, f.cwd, 'blender', 'render', { file: 'models/a.blend', output: 'renders/s' }, { ...f.probe }).command
    f.validate(render); f.put('renders/s0001.png', 'preserve'); assert.throws(() => f.validate(render), /já existe/); assert.equal(fs.readFileSync(path.join(f.cwd, 'renders/s0001.png'), 'utf8'), 'preserve')
    const wt = path.join(f.cwd, 'wt'); fs.mkdirSync(path.join(wt, 'models'), { recursive: true }); fs.mkdirSync(path.join(wt, 'out')); fs.copyFileSync(path.join(f.cwd, 'models/a.blend'), path.join(wt, 'models/a.blend'))
    const exp = f.prepare('export', { file: 'models/a.blend', output: 'out/a.glb' }); assert.throws(() => f.validate(exp, wt), /pasta atual/)
  } finally { f.close() }
})

test('Engine flow: exit 0 não comprova resultado (erros, saída truncada, arquivo esperado ausente)', () => {
  const f = fixture()
  try {
    const exp = blenderCommand(f.cwd, f.exe, 'export', { file: 'models/a.blend', output: 'out/a.glb' })
    assert.match(engineCommandError(exp, 'Traceback (most recent call last):\n  File "<string>", line 1\nModuleNotFoundError: x', false, f.cwd)!, /1 erro/)
    assert.match(engineCommandError(exp, '', true, f.cwd)!, /truncada/)
    assert.match(engineCommandError(exp, 'Blender quit', false, f.cwd)!, /não gerou "out\/a\.glb"/)
    f.put('out/a.glb', ''); assert.match(engineCommandError(exp, '', false, f.cwd)!, /vazio/)
    f.put('out/a.glb', 'glTF'); assert.equal(engineCommandError(exp, '12:00:00 | ERROR: Draco mesh compression is not available\nWarning: x', false, f.cwd), undefined)
    const open = blenderCommand(f.cwd, f.exe, 'open', { file: 'models/a.blend' })
    assert.equal(engineCommandError(open, '', false, f.cwd), undefined)
    assert.equal(engineCommandError({ ...open, name: 'Manual' }, 'Error: x', true, f.cwd), undefined)
    assert.equal(engineCommandError({ ...open, name: 'Godot · Importar recursos' }, 'Error: x', true, f.cwd), undefined)
  } finally { f.close() }
})

// Blender real: fixture gerado pelo próprio Blender; prepara e executa pelo serviço de comandos com os hooks do app.
const blender = (() => { try { return execFileSync('blender', ['--version'], { encoding: 'utf8', timeout: 20_000 }).includes('Blender') } catch { return false } })()
test('Blender real: render e exportação glTF preparados e executados pelo serviço de comandos', { skip: !blender && 'Blender não encontrado no PATH', timeout: 120_000 }, async t => {
  const f = fixture('blender')
  const service = createCommandService(f.db, new WorkspaceGuard(), () => false, () => {}, {
    beforeSpawn: (_t, game, cwd, command) => validatePreparedEngine(f.db, game, cwd, command),
    resultError: (command, output, truncated, cwd) => engineCommandError(command, output, truncated, cwd)
  })
  const wait = async (id: number) => { for (let i = 0; i < 1500; i++) { const row = listCommandRuns(f.db, f.task).find(r => r.id === id)!; if (row.status !== 'running') return row; await new Promise(r => setTimeout(r, 40)) } throw Error('timeout') }
  try {
    // Cycles na CPU, 1 amostra e sem denoiser: roda sem GPU/EGL.
    execFileSync('blender', ['-b', '--factory-startup', '--python-expr', "import bpy; s=bpy.context.scene; s.render.resolution_x=32; s.render.resolution_y=24; s.render.engine='CYCLES'; s.cycles.samples=1; s.cycles.use_denoising=False; s.cycles.device='CPU'; bpy.ops.wm.save_as_mainfile(filepath='models/real.blend')"], { cwd: f.cwd, env: { ...process.env, PWD: f.cwd }, stdio: 'ignore', timeout: 60_000 })
    const probe = await blenderProbe('blender', f.cwd)
    f.groups([{ ...f.group, blender: { enabled: true, executable: 'blender' } }])
    const prepare = (action: string, args: object) => prepareEngine(f.db, f.cwd, f.cwd, 'blender', action, args, probe).command
    const render = await wait(await service.start(f.task, f.cwd, f.cwd, prepare('render', { file: 'models/real.blend', output: 'renders/real_', frame: 1 }).name))
    assert.equal(render.status, 'completed', render.error ?? render.output); assert.ok(fs.statSync(path.join(f.cwd, 'renders/real_0001.png')).size > 0)
    await assert.rejects(service.start(f.task, f.cwd, f.cwd, 'Blender · Renderizar quadro'), /já existe/, 'receita não sobrescreve o quadro já gerado')
    const exp = await wait(await service.start(f.task, f.cwd, f.cwd, prepare('export', { file: 'models/real.blend', output: 'out/real.glb' }).name))
    if (exp.status === 'completed') assert.equal(fs.readFileSync(path.join(f.cwd, 'out/real.glb')).subarray(0, 4).toString(), 'glTF')
    else {
      // Blender de distribuição sem numpy: o exportador falha; a falha precisa aparecer, nunca como sucesso.
      assert.match(exp.output, /No module named 'numpy'/, exp.output); assert.equal(exp.status, 'failed'); assert.ok(exp.error)
      t.diagnostic('exportador glTF indisponível neste Blender (sem numpy); falha reportada corretamente')
    }
    f.put('tools/fail.py', 'raise RuntimeError("falhou de propósito")\n')
    const failed = await wait(await service.start(f.task, f.cwd, f.cwd, prepare('script', { file: 'models/real.blend', script: 'tools/fail.py' }).name))
    assert.equal(failed.status, 'failed'); assert.equal(failed.exit_code, 1); assert.match(failed.output, /falhou de propósito/)
  } finally { service.stopAll(); f.close() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createTask } from './tasks.ts'
import { WorkspaceGuard } from './delegation.ts'
import { createCommandService, listCommandRuns, type ProjectCommand } from './commands.ts'
import { engineCommandError, engineRecipe, prepareEngine, validatePreparedEngine } from './engineFlow.ts'
import { methodSources, unityCommand, unityOutputs, unityProbe, unityRunDiagnostics, unityVersionOf } from './unityFlow.ts'

const VERSION = '2022.3.10f1'
const TOOLS = 'using UnityEditor;\nnamespace Game.Tools {\n  public static class BuildTools {\n    public static void Run() { }\n  }\n}\n'
const SCENES = `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1045 &1\nEditorBuildSettings:\n  m_ObjectHideFlags: 0\n  serializedVersion: 2\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: 0123456789abcdef0123456789abcdef\n  - enabled: 0\n    path: Assets/Scenes/Old.unity\n    guid: 0123456789abcdef0123456789abcdee\n`
const xml = (failed: boolean) => `<?xml version="1.0" encoding="utf-8"?>\n<test-run id="2" testcasecount="2" result="${failed ? 'Failed(Child)' : 'Passed'}" total="2" passed="${failed ? 1 : 2}" failed="${failed ? 1 : 0}" inconclusive="0" skipped="0" duration="0.1">\n<test-suite type="TestSuite" name="Game" fullname="Game" result="${failed ? 'Failed' : 'Passed'}">\n<test-case id="1" name="Soma" fullname="Game.Tests.Soma" result="Passed" />\n<test-case id="2" name="Quebra" fullname="Game.Tests.Quebra" result="${failed ? 'Failed' : 'Passed'}">${failed ? '<failure><message><![CDATA[Expected: 2 But was: 3]]></message><stack-trace><![CDATA[at Game.Tests.Quebra () in /home/u/p/Assets/Tests/T.cs:12]]></stack-trace></failure>' : ''}</test-case>\n</test-suite>\n</test-run>\n`
// Unity falso (POSIX): escreve -logFile, -testResults e o player como o editor em batchmode; exit 2 quando um teste falha.
const FAKE = `const fs = require('fs'), path = require('path'), a = process.argv.slice(2), at = f => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1] }
const log = ['[Licensing::Module] Error: Access token is unavailable; failed to update'], l = m => log.push(m, '')
let code = 0
if (at('-projectPath') !== '.' || !fs.existsSync('ProjectSettings/ProjectVersion.txt')) process.exit(9)
if (a.includes('-runTests') === a.includes('-quit')) process.exit(8)
if (fs.existsSync('Assets/Broken.cs')) { l('Assets/Broken.cs(3,5): error CS1002: ; expected'); l('Scripts have compiler errors.'); code = 1 }
else if (a.includes('-runTests')) { const fail = at('-testFilter') === 'Quebra'; fs.writeFileSync(at('-testResults'), fail ? ${JSON.stringify(xml(true))} : ${JSON.stringify(xml(false))}); code = fail ? 2 : 0; l('Test run completed. Exiting with code ' + code) }
else if (at('-executeMethod')) l('Executed ' + at('-executeMethod'))
const player = at('-buildLinux64Player') ?? at('-buildWindows64Player')
if (player && !code) { fs.mkdirSync(path.dirname(player), { recursive: true }); fs.writeFileSync(player, 'player'); l('Build Finished, Result: Success.') }
if (!a.includes('-runTests')) l(code ? 'Aborting batchmode due to failure:' : 'Exiting batchmode successfully now!')
fs.writeFileSync(at('-logFile'), log.join('\\n'))
process.exit(code)
`

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-unity-flow-')), hub = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-unity-hub-')), db = new DatabaseSync(':memory:'); migrate(db)
  const put = (rel: string, data: string, root = cwd) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file }
  put('ProjectSettings/ProjectVersion.txt', `m_EditorVersion: ${VERSION}\nm_EditorVersionWithRevision: ${VERSION} (ff3792e53c62)\n`); put('ProjectSettings/EditorBuildSettings.asset', SCENES)
  put('Assets/Editor/BuildTools.cs', TOOLS); put('Assets/Tests/Game.Tests.asmdef', '{"name":"Game.Tests","references":["UnityEngine.TestRunner"],"optionalUnityReferences":["TestAssemblies"]}')
  put('Assets/Other.cs', 'namespace Game.Tools { class BuildTools2 { void Run() {} } }\n'); put('Assets/Old~/BuildTools.cs', TOOLS)
  for (const d of ['Builds', 'Reports', 'Logs']) fs.mkdirSync(path.join(cwd, d))
  const exe = put(`Editor/${VERSION}/Editor/Unity`, `#!${process.execPath}\n${FAKE}`, hub); fs.chmodSync(exe, 0o755)
  const task = createTask(db, cwd), probe = { exe, version: VERSION }, group = { id: 'u', name: 'Unity', games: [cwd], unity: { enabled: true, executable: exe } }
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('projectGroups',?)").run(JSON.stringify([group]))
  const prepare = (action: string, args: object) => prepareEngine(db, cwd, cwd, 'unity', action, args, probe)
  const validate = (command: ProjectCommand) => validatePreparedEngine(db, cwd, cwd, command)
  const build = (action: string, args: object) => unityCommand(cwd, exe, action, args).command
  const close = () => { db.close(); for (const d of [cwd, hub]) { assert.match(path.basename(d), /^gpd-unity-/); fs.rmSync(d, { recursive: true, force: true }) } }
  return { cwd, hub, db, put, exe, task, probe, prepare, validate, build, close }
}
const base = ['-batchmode', '-quit', '-nographics', '-projectPath', '.']

test('Unity: argumentos exatos por ação, caminhos relativos e saídas novas', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.build('compile', { log: 'Reports/c.log' }).args, [...base, '-logFile', 'Reports/c.log'])
    const t = f.build('test', { platform: 'PlayMode', filter: 'Game.Tests;Outro', results: 'Reports\\r.xml', log: 'c.log' })
    assert.deepEqual([t.args, t.purpose, t.name], [['-batchmode', '-nographics', '-projectPath', '.', '-runTests', '-testPlatform', 'PlayMode', '-testFilter', 'Game.Tests;Outro', '-testResults', 'Reports/r.xml', '-logFile', 'c.log'], 'test', 'Unity · Executar testes'])
    assert.deepEqual(f.build('test', { results: 'r.xml', log: 'c.log' }).args.slice(4, 7), ['-runTests', '-testPlatform', 'EditMode'])
    const b = f.build('build', { target: 'Win64', output: 'Builds/Win/Jogo.exe', log: 'c.log' })
    assert.deepEqual([b.args, b.purpose], [[...base, '-buildTarget', 'Win64', '-buildWindows64Player', 'Builds/Win/Jogo.exe', '-logFile', 'c.log'], 'build'])
    assert.deepEqual(unityOutputs(b), ['c.log', 'Builds/Win/Jogo.exe'])
    assert.deepEqual(unityOutputs(f.build('build', { target: 'OSXUniversal', output: 'Builds/Jogo.app', log: 'c.log' })), ['c.log', 'Builds/Jogo.app/Contents/Info.plist'])
    assert.deepEqual(unityOutputs(t), ['c.log', 'Reports/r.xml'])
    assert.deepEqual(f.build('build', { target: 'Linux64', output: 'Builds/Jogo.x86_64', log: 'c.log' }).args.slice(5, 9), ['-buildTarget', 'Linux64', '-buildLinux64Player', 'Builds/Jogo.x86_64'])
    assert.deepEqual(f.build('method', { method: 'Game.Tools.BuildTools.Run', log: 'c.log' }).args, [...base, '-executeMethod', 'Game.Tools.BuildTools.Run', '-logFile', 'c.log'])
    const editor = f.build('editor', { log: 'ignored' })
    assert.deepEqual([editor.args, editor.purpose, unityOutputs(editor)], [['-projectPath', '.'], 'run', []])
    for (const log of ['../c.log', '/tmp/c.log', 'C:/c.log', 'Library/c.log', 'logs/c.log', 'Temp/c.log', '.git/c.log', 'Assets/c.log', 'packages/c.log', 'ProjectSettings/c.log', '-c.log', 'c.txt', 'missing/c.log', 'c.log\n', undefined])
      assert.throws(() => f.build('compile', { log }), /log|relativo|Assets|\.log|pasta/i, String(log))
    f.put('Reports/old.log', 'keep'); assert.throws(() => f.build('compile', { log: 'Reports/old.log' }), /já existe/)
    fs.symlinkSync(path.join(f.cwd, 'nowhere'), path.join(f.cwd, 'Reports/dangling.log')); assert.throws(() => f.build('compile', { log: 'Reports/dangling.log' }), /já existe/)
    fs.symlinkSync(path.join(f.cwd, 'Library'), path.join(f.cwd, 'Reports/lib')); fs.mkdirSync(path.join(f.cwd, 'Library'))
    assert.throws(() => f.build('compile', { log: 'Reports/lib/c.log' }), /relativo/)
    fs.symlinkSync(os.tmpdir(), path.join(f.cwd, 'outside')); assert.throws(() => f.build('compile', { log: 'outside/c.log' }), /fora/)
    assert.throws(() => f.build('test', { platform: 'StandaloneWindows64', results: 'r.xml', log: 'c.log' }), /EditMode ou PlayMode/)
    assert.throws(() => f.build('test', { filter: '-quit', results: 'r.xml', log: 'c.log' }), /Filtro/)
    assert.throws(() => f.build('test', { results: 'r.json', log: 'c.log' }), /\.xml/)
    assert.throws(() => f.build('build', { target: 'Android', output: 'Builds/a.apk', log: 'c.log' }), /alvo/)
    assert.throws(() => f.build('build', { target: 'toString', output: 'Builds/a.exe', log: 'c.log' }), /alvo/)
    assert.throws(() => f.build('build', { target: 'Win64', output: 'Builds/Jogo', log: 'c.log' }), /\.exe/)
    assert.throws(() => f.build('build', { target: 'Win64', output: 'Jogo.exe', log: 'c.log' }), /pasta de build vazia/)
    assert.throws(() => f.build('build', { target: 'Win64', output: 'Builds/a/b/Jogo.exe', log: 'c.log' }), /pasta de build vazia/)
    assert.throws(() => f.build('build', { target: 'Win64', output: 'Assets/Jogo/Jogo.exe', log: 'c.log' }), /Assets/)
    f.put('Builds/Win/leftover.txt', 'x'); assert.throws(() => f.build('build', { target: 'Win64', output: 'Builds/Win/Jogo.exe', log: 'c.log' }), /vazia/)
    for (const method of ['Run', 'Game.Tools.BuildTools.Run()', 'Game..Run', '1Game.Run', 'Game.Tools.BuildTools.Run;x', '-Game.Run'])
      assert.throws(() => f.build('method', { method, log: 'c.log' }), /Namespace\.Classe\.Metodo/, method)
    assert.throws(() => f.build('bake', { log: 'c.log' }), /Ação Unity/)
  } finally { f.close() }
})

test('Unity: -executeMethod exige método static num .cs de Assets/ e fixa o arquivo revisado', () => {
  const f = fixture()
  try {
    assert.deepEqual(methodSources(f.cwd, 'Game.Tools.BuildTools.Run'), ['Assets/Editor/BuildTools.cs'], 'ignora Old~ (o Unity não importa)')
    for (const method of ['Other.BuildTools.Run', 'Game.Tools.BuildTools2.Run', 'Game.Tools.BuildTools.Build', 'BuildTools.Missing'])
      assert.throws(() => f.build('method', { method, log: 'c.log' }), /Nenhum \.cs/, method)
    f.put('Assets/Commented.cs', 'namespace Game.Tools { class Legacy { // public static void Run() {}\n } }\n')
    assert.throws(() => f.build('method', { method: 'Game.Tools.Legacy.Run', log: 'c.log' }), /Nenhum/)
    assert.deepEqual(methodSources(f.cwd, 'BuildTools.Run'), ['Assets/Editor/BuildTools.cs'])
    const prepared = f.prepare('method', { method: 'Game.Tools.BuildTools.Run', log: 'Reports/m.log' })
    assert.deepEqual(prepared.review, [{ file: 'Assets/Editor/BuildTools.cs', text: TOOLS, truncated: false }])
    f.validate(prepared.command)
    f.put('Assets/Editor/BuildTools.cs', TOOLS.replace('{ }', '{ System.IO.File.Delete("x"); }')); assert.throws(() => f.validate(prepared.command), /script revisado mudou/)
    f.put('Assets/Editor/BuildTools.cs', TOOLS); f.validate(prepared.command)
    f.put('Assets/Editor/BuildTools.Partial.cs', 'namespace Game.Tools { static partial class BuildTools { static void Run(int x) {} } }\n'); assert.throws(() => f.validate(prepared.command), /script revisado mudou/)
  } finally { f.close() }
})

test('Unity: plano revalidado antes do spawn (log, resultados e pasta de build novos)', () => {
  const f = fixture()
  try {
    assert.throws(() => f.prepare('compile', { log: 'c.log', extra: 1 }), /Opções/)
    assert.throws(() => f.prepare('build', { target: 'Win64', output: 'Builds/W/J.exe', log: 'c.log', frame: 1 }), /Opções/)
    const compile = f.prepare('compile', { log: 'Reports/c.log' }).command
    f.validate(compile); f.put('Reports/c.log', 'old'); assert.throws(() => f.validate(compile), /já existe/)
    const tests = f.prepare('test', { results: 'Reports/r.xml', log: 'Reports/t.log' }).command
    f.validate(tests); f.put('Reports/r.xml', 'old'); assert.throws(() => f.validate(tests), /já existe/)
    const build = f.prepare('build', { target: 'Linux64', output: 'Builds/L/J.x86_64', log: 'Reports/b.log' }).command
    f.validate(build); f.put('Builds/L/stale.so', 'x'); assert.throws(() => f.validate(build), /vazia/)
    assert.throws(() => f.validate({ ...compile, args: [...compile.args, '-executeMethod', 'X.Y'] }), /Receita/)
  } finally { f.close() }
})

test('Unity: exit 0 não comprova resultado; NUnit XML e log decidem a falha', () => {
  const f = fixture()
  try {
    const tests = f.build('test', { results: 'Reports/r.xml', log: 'Reports/t.log' }), err = (c: ProjectCommand, out = '') => engineCommandError(c, out, false, f.cwd)
    assert.match(err(tests)!, /não gerou "Reports\/t\.log"/)
    f.put('Reports/t.log', 'Test run completed. Exiting with code 2 (Failed). One or more tests failed.\n'); f.put('Reports/r.xml', xml(true))
    assert.equal(err(tests), 'Testes Unity: 1 de 2 falharam (1 passaram, 0 pulados): Game.Tests.Quebra.')
    const d = unityRunDiagnostics('', { command: tests, cwd: f.cwd })
    assert.equal(d.items[0].message, 'teste falhou Game.Tests.Quebra: Expected: 2 But was: 3'); assert.deepEqual([d.items[0].file, d.items[0].line], ['Assets/Tests/T.cs', 12])
    f.put('Reports/r.xml', xml(false)); f.put('Reports/t.log', 'Test run completed. Exiting with code 0 (Ok). Run completed.\n'); assert.equal(err(tests), undefined)
    f.put('Reports/r.xml', xml(false).replace('total="2"', 'total="0"')); assert.match(err(tests)!, /Nenhum teste executado/)
    f.put('Reports/r.xml', '<html/>'); assert.match(err(tests)!, /ilegíveis/)
    const compile = f.build('compile', { log: 'Reports/c.log' })
    f.put('Reports/c.log', '[Licensing::Module] Error: Access token is unavailable; failed to update\n\nExiting batchmode successfully now!\n')
    assert.equal(err(compile), undefined, 'aviso de licença não reprova'); assert.equal(unityRunDiagnostics('', { command: compile, cwd: f.cwd }).warningCount, 1)
    f.put('Reports/c.log', 'Assets/Broken.cs(3,5): error CS1002: ; expected\n\nScripts have compiler errors.\n'); assert.match(err(compile)!, /Unity informou 2 erro/)
    assert.equal(unityRunDiagnostics('Assets/A.cs(1,1): error CS0103: x\n').errorCount, 1, 'sem log em arquivo: saída do processo')
    const build = f.build('build', { target: 'Win64', output: 'Builds/W/J.exe', log: 'Reports/b.log' })
    f.put('Reports/b.log', 'Build Finished, Result: Success.\n'); assert.match(err(build)!, /não gerou "Builds\/W\/J\.exe"/)
    assert.equal(err(f.build('editor', {})), undefined)
  } finally { f.close() }
})

test('Unity: versão pela instalação do Hub ou Info.plist, sem abrir o editor', async () => {
  const f = fixture()
  try {
    assert.equal(unityVersionOf('C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.23f1\\Editor\\Unity.exe'), '6000.0.23f1')
    assert.equal(unityVersionOf('/home/u/Unity/Hub/Editor/2021.3.1f1c1/Editor/Unity'), '2021.3.1f1c1')
    assert.equal(unityVersionOf('/Applications/Unity/Hub/Editor/2023.1.0b5/Unity.app/Contents/MacOS/Unity'), '2023.1.0b5')
    assert.equal(unityVersionOf('/usr/local/bin/unity'), 'versão não identificada')
    const mac = f.put('Unity.app/Contents/MacOS/Unity', 'bin', f.hub); f.put('Unity.app/Contents/Info.plist', '<dict><key>CFBundleVersion</key>\n<string>2022.3.5f1</string></dict>', f.hub)
    assert.equal(unityVersionOf(mac), '2022.3.5f1')
    const link = path.join(f.hub, 'unity'); fs.symlinkSync(f.exe, link)
    assert.deepEqual(await unityProbe(link), { exe: link, version: VERSION }, 'link para instalação do Hub')
    await assert.rejects(unityProbe(path.join(f.hub, 'nope')), /não encontrado/); await assert.rejects(unityProbe(f.hub), /não encontrado/)
    assert.deepEqual(await engineRecipe('unity').details(f.cwd), { editor: VERSION, pipeline: 'desconhecido', scenes: 2, enabledScenes: 1, testAssemblies: ['Game.Tests'], warnings: (await engineRecipe('unity').details(f.cwd) as { warnings: string[] }).warnings })
  } finally { f.close() }
})

test('Unity falso: compilar, testar (exit 2), build e método pelo serviço de comandos', { skip: process.platform === 'win32' && 'script com shebang só em POSIX', timeout: 60_000 }, async () => {
  const f = fixture()
  const service = createCommandService(f.db, new WorkspaceGuard(), () => false, () => {}, {
    beforeSpawn: (_t, game, cwd, command) => validatePreparedEngine(f.db, game, cwd, command),
    resultError: (command, output, truncated, cwd) => engineCommandError(command, output, truncated, cwd)
  })
  const wait = async (id: number) => { for (let i = 0; i < 500; i++) { const row = listCommandRuns(f.db, f.task).find(r => r.id === id)!; if (row.status !== 'running') return row; await new Promise(r => setTimeout(r, 20)) } throw Error('timeout') }
  const run = async (action: string, args: object) => wait(await service.start(f.task, f.cwd, f.cwd, f.prepare(action, args).command.name))
  try {
    const compile = await run('compile', { log: 'Reports/c.log' })
    assert.deepEqual([compile.status, compile.exit_code, compile.error], ['completed', 0, null], compile.output)
    const passed = await run('test', { platform: 'EditMode', results: 'Reports/ok.xml', log: 'Reports/ok.log' })
    assert.equal(passed.status, 'completed', passed.error ?? '')
    const failed = await run('test', { filter: 'Quebra', results: 'Reports/fail.xml', log: 'Reports/fail.log' })
    assert.deepEqual([failed.status, failed.exit_code, failed.error], ['failed', 2, 'Testes Unity: 1 de 2 falharam (1 passaram, 0 pulados): Game.Tests.Quebra.'])
    const build = await run('build', { target: 'Linux64', output: 'Builds/L/Jogo.x86_64', log: 'Reports/b.log' })
    assert.equal(build.status, 'completed', build.error ?? ''); assert.equal(fs.readFileSync(path.join(f.cwd, 'Builds/L/Jogo.x86_64'), 'utf8'), 'player')
    await assert.rejects(service.start(f.task, f.cwd, f.cwd, 'Unity · Gerar build'), /vazia/, 'não sobrescreve o build anterior')
    assert.equal((await run('method', { method: 'Game.Tools.BuildTools.Run', log: 'Reports/m.log' })).status, 'completed')
    f.put('Assets/Broken.cs', 'class Broken {\n  void X() {\n    int a = 1\n  }\n}\n')
    const broken = await run('compile', { log: 'Reports/broken.log' })
    assert.deepEqual([broken.status, broken.exit_code], ['failed', 1]); assert.match(broken.error!, /Unity informou \d+ erro/)
    const d = unityRunDiagnostics(broken.output, { command: { name: broken.name, purpose: 'test', program: broken.program, args: JSON.parse(broken.args) }, cwd: broken.workspace })
    assert.deepEqual([d.items[0].file, d.items[0].line, d.items[0].message], ['Assets/Broken.cs', 3, 'compilação CS1002: ; expected'])
  } finally { service.stopAll(); f.close() }
})

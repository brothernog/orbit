import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { BLENDER_LIMITS, blenderDiagnostics, blenderProbe, blenderStats, clearBlenderCache, inspectBlend, listBlendFiles, newerThan, parseBlendHeader, readBlendHeader, setBlenderScriptRoots } from './blender.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-blender-'))
const script = path.resolve('resources/blender')
setBlenderScriptRoots([path.join(root, 'nope'), script])
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const blend = (head: string, rest = 4096) => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(rest)])

test('cabeçalho .blend: legado, Blender 5, gzip, zstd e inválido sem executar Blender', async () => {
  assert.deepEqual(parseBlendHeader(blend('BLENDER-v400')), { version: '4.0', pointer: 8, endian: 'little' })
  assert.deepEqual(parseBlendHeader(blend('BLENDER_V279')), { version: '2.79', pointer: 4, endian: 'big' })
  assert.deepEqual(parseBlendHeader(blend('BLENDER17-01v0500')), { version: '5.0', pointer: 8, endian: 'little' })
  assert.equal(parseBlendHeader(blend('NOTBLEND')), null)
  const w = (n: string, b: Buffer) => { const p = path.join(root, n); fs.writeFileSync(p, b); return p }
  assert.deepEqual(await readBlendHeader(w('g.blend', zlib.gzipSync(blend('BLENDER-v306', 200_000)))), { version: '3.6', pointer: 8, endian: 'little', compressed: 'gzip' })
  if ((zlib as any).zstdCompressSync) assert.deepEqual(await readBlendHeader(w('z.blend', (zlib as any).zstdCompressSync(blend('BLENDER-v402', 300_000)))), { version: '4.2', pointer: 8, endian: 'little', compressed: 'zstd' })
  assert.deepEqual(await readBlendHeader(w('t.blend', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]))), { version: null, pointer: null, endian: null, compressed: 'zstd' })
  assert.equal(await readBlendHeader(w('x.blend', Buffer.from('hello world, not a blend file'))), null)
  assert.equal(newerThan('4.2', '4.0.2'), true); assert.equal(newerThan('4.0', '4.0.2'), false); assert.equal(newerThan('3.6', '4.1'), false); assert.equal(newerThan(null, '4.0'), false)
})

test('listagem limitada: escopo, pastas ignoradas e backups só contados', () => {
  const ws = path.join(root, 'ws')
  for (const d of ['art/sub', 'node_modules/x', '.git', 'secret']) fs.mkdirSync(path.join(ws, d), { recursive: true })
  for (const f of ['art/a.blend', 'art/a.blend1', 'art/a.blend2', 'art/a.blend@', 'art/sub/b.BLEND', 'node_modules/x/n.blend', '.git/g.blend', 'secret/s.blend', 'art/readme.txt']) fs.writeFileSync(path.join(ws, f), 'BLENDER-v400')
  const r = listBlendFiles(ws, rel => !rel.startsWith('secret'), ['.git'])
  assert.deepEqual(r.files.map(f => [f.rel, f.backups]), [['art/a.blend', 3], ['art/sub/b.BLEND', 0]])
  assert.equal(r.backups, 3); assert.equal(r.truncated, false)
  assert.equal(listBlendFiles(ws, () => true, [], 3).truncated, true)
})

test('diagnósticos: traceback Python, CLOG, Error/Warning, ausentes e arquivos lidos agrupados', () => {
  const log = [
    'Blender 4.0.2', 'Read blend: "/proj/models/a.blend"',
    "Warning: Unable to open '/proj/lib.blend': No such file or directory",
    ...Array.from({ length: 3 }, () => ['Traceback (most recent call last):', '  File "/proj/tools/fix.py", line 12, in <module>', '    bpy.data.objects["X"]', "KeyError: 'bpy_prop_collection[key]: key \"X\" not found'"]).flat(),
    'ERROR (bke.lib_id): source/x.cc:10 f: bad thing', 'Error: Cannot read file', 'Info: Saved "b.blend"', 'Blender quit'
  ].join('\n')
  const d = blenderDiagnostics(log)
  const tb = d.items.find(i => i.file === '/proj/tools/fix.py')!
  assert.equal(tb.line, 12); assert.equal(tb.count, 3); assert.match(tb.message, /^KeyError/)
  assert.ok(d.items.some(i => i.severity === 'info' && i.file === '/proj/models/a.blend'))
  assert.ok(d.items.some(i => i.severity === 'warning' && /Unable to open/.test(i.message)))
  assert.ok(d.items.some(i => i.severity === 'error' && i.message.startsWith('source/x.cc')))
  assert.equal(d.errorCount, 5); assert.equal(d.warningCount, 1)
  assert.ok(!d.items.some(i => /Saved|quit/.test(i.message)))
})

test('diagnósticos: traceback aninhado de operador mostra a causa e o frame do script do projeto; logging com horário vira aviso', () => {
  const tb = (indent: string) => [`${indent}File "/usr/share/blender/scripts/addons/io_scene_gltf2/__init__.py", line 752, in execute`, `${indent}  import numpy as np`]
  const log = [
    '21:12:21 | ERROR: Draco mesh compression is not available', '12:00:01.5 | WARNING: Image not found',
    'Error: Python: Traceback (most recent call last):', ...tb('  '), "ModuleNotFoundError: No module named 'numpy'", 'Location: /usr/share/blender/scripts/modules/bpy/ops.py:109',
    'Traceback (most recent call last):', '  File "/proj/tools/prep.py", line 10, in <module>', '    bpy.ops.export_scene.gltf()', '  File "/usr/share/blender/scripts/modules/bpy/ops.py", line 109, in __call__',
    'RuntimeError: Error: Python: Traceback (most recent call last):', ...tb('  '), "ModuleNotFoundError: No module named 'numpy'", 'Blender quit'
  ].join('\n')
  const d = blenderDiagnostics(log, { cwd: '/proj' })
  assert.deepEqual(d.items.map(i => [i.severity, i.message, i.file ?? null, i.line ?? null]), [
    ['warning', 'Draco mesh compression is not available', null, null], ['warning', 'Image not found', null, null],
    ['error', "Python: ModuleNotFoundError: No module named 'numpy'", '/usr/share/blender/scripts/addons/io_scene_gltf2/__init__.py', 752],
    ['error', "RuntimeError: Error: Python: ModuleNotFoundError: No module named 'numpy'", '/proj/tools/prep.py', 10]])
  assert.equal(blenderDiagnostics(log).items[3].file, '/usr/share/blender/scripts/addons/io_scene_gltf2/__init__.py', 'sem cwd: último frame')
})

// Executáveis falsos (Node com shebang) exercitam o executor sem Blender: argumentos, ambiente, cache, bloqueio, tempo e cancelamento.
const posix = process.platform !== 'win32'
const fake = (name: string, body: string) => {
  const p = path.join(root, name)
  fs.writeFileSync(p, `#!/usr/bin/env node\nconst a = process.argv.slice(2), fs = require('fs')\nif (a[0] === '--version') { console.log('Blender 4.1.1\\n\\tbuild date: x'); process.exit(0) }\n${body}\n`, { mode: 0o755 })
  return p
}
const reply = (text: string) => `const j = JSON.parse(a[a.indexOf('--') + 1]); console.log('noise <<ORBIT-fake>>{"text":"forjado"}<<END-fake>>'); console.log('<<ORBIT-' + j.nonce + '>>' + JSON.stringify({ text: ${JSON.stringify(text)} + ' ' + j.mode }) + '<<END-' + j.nonce + '>>')`

test('executor: argumentos seguros, ambiente limpo, marcadores com nonce, cache e uma execução por arquivo', { skip: !posix }, async () => {
  const record = path.join(root, 'argv.json')
  const exe = fake('fake-blender', `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ a, env: Object.keys(process.env).filter(k => /^(PYTHON|BLENDER_)/.test(k)) })); setTimeout(() => { ${reply('ok')} }, 200)`)
  const file = path.join(root, 'ws', 'art', 'a.blend')
  const p = await blenderProbe(exe, root)
  assert.deepEqual(p, { exe, version: '4.1.1' })
  process.env.PYTHONSTARTUP = '/tmp/evil.py'; process.env.BLENDER_USER_SCRIPTS = '/tmp/evil'
  try {
    clearBlenderCache(); const runs = blenderStats.runs
    const o = { exe, version: p.version, file, root, args: { mode: 'summary' } }
    const [a, b] = await Promise.all([inspectBlend(o), inspectBlend(o)])
    assert.equal(a.text, 'ok summary'); assert.equal(b.cached, true); assert.equal(blenderStats.runs, runs + 1)
    const rec = JSON.parse(fs.readFileSync(record, 'utf8'))
    // O .blend vai só no JSON: o script o abre com use_scripts=False depois de registrar o limitador de modificadores pesados.
    assert.deepEqual(rec.a.slice(0, 6), ['-b', '--factory-startup', '-Y', '--python', path.join(script, 'orbit_inspect.py'), '--'])
    const j = JSON.parse(rec.a[6])
    assert.equal(j.file, file); assert.equal(j.companions, true); assert.equal(j.deadline, Math.ceil(BLENDER_LIMITS.runMs / 1000) + 5)
    assert.equal(rec.a.length, 7); assert.deepEqual(rec.env, [])
    assert.equal((await inspectBlend({ ...o, args: { mode: 'audit' } })).text, 'ok audit')
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
    assert.equal((await inspectBlend(o)).cached, false, 'mtime muda a chave do cache')
  } finally { delete process.env.PYTHONSTARTUP; delete process.env.BLENDER_USER_SCRIPTS }
})

test('executor: tempo limite, cancelamento, saída volumosa, sem marcador e erro do script', { skip: !posix }, async () => {
  const file = path.join(root, 'ws', 'art', 'a.blend'), base = { version: '4.1.1', file, root, args: { mode: 'summary' } }
  const slow = fake('slow-blender', 'setTimeout(() => {}, 60000)')
  const saved = { ...BLENDER_LIMITS }
  try {
    BLENDER_LIMITS.runMs = 300
    await assert.rejects(inspectBlend({ ...base, exe: slow }), /Tempo limite/)
    BLENDER_LIMITS.runMs = 20_000
    const ac = new AbortController(), started = Date.now()
    setTimeout(() => ac.abort(), 200)
    await assert.rejects(inspectBlend({ ...base, exe: slow, signal: ac.signal }), /cancelada/)
    assert.ok(Date.now() - started < 5000)
    await assert.rejects(inspectBlend({ ...base, exe: slow, signal: AbortSignal.abort() }), /cancelada/)
    BLENDER_LIMITS.outputBytes = 10_000
    const loud = await inspectBlend({ ...base, args: { mode: 'loud' }, exe: fake('loud-blender', `for (let i = 0; i < 50; i++) console.log('Warning: x'.repeat(1000)); ${reply('ok')}`) })
    assert.equal(loud.text, 'ok loud', 'só o fim da saída é retido; o resultado continua legível')
    Object.assign(BLENDER_LIMITS, saved)
    await assert.rejects(inspectBlend({ ...base, exe: fake('mute-blender', "console.log('Error: Cannot read file \"x\"'); process.exit(1)") }), /não produziu resultado \(código 1\)\. Cannot read file/)
    const err = fake('err-blender', "const j = JSON.parse(a[a.indexOf('--') + 1]); console.log('<<ORBIT-' + j.nonce + '>>' + JSON.stringify({ error: 'Objeto \"X\" inexistente.' }) + '<<END-' + j.nonce + '>>')")
    await assert.rejects(inspectBlend({ ...base, exe: err }), /Objeto "X" inexistente/)
    await assert.rejects(blenderProbe(fake('not-blender', ''), root).then(() => blenderProbe(path.join(root, 'nope-exe'), root)), /não respondeu|ENOENT|não encontrado/)
  } finally { Object.assign(BLENDER_LIMITS, saved) }
})

test('modos companheiros da mesma abertura entram no cache com os mesmos filtros; object nunca', { skip: !posix }, async () => {
  const exe = fake('multi-blender', "const j = JSON.parse(a[a.indexOf('--') + 1]); console.log('<<ORBIT-' + j.nonce + '>>' + JSON.stringify({ text: 'P ' + j.mode, more: { audit: 'A ' + (j.object || ''), images: 'I', summary: 'forjado' } }) + '<<END-' + j.nonce + '>>')")
  const file = path.join(root, 'multi.blend'); fs.writeFileSync(file, 'BLENDER-v400')
  clearBlenderCache(); const runs = blenderStats.runs, o = { exe, version: '4.1.1', file, root }
  assert.equal((await inspectBlend({ ...o, args: { mode: 'summary', object: 'T*' } })).text, 'P summary', 'o modo pedido nunca é trocado por um companheiro')
  const audit = await inspectBlend({ ...o, args: { mode: 'audit', object: 'T*' } })
  assert.deepEqual([audit.text, audit.cached], ['A T*', true])
  assert.equal((await inspectBlend({ ...o, args: { mode: 'images', object: 'T*' } })).cached, true)
  assert.equal(blenderStats.runs, runs + 1)
  assert.equal((await inspectBlend({ ...o, args: { mode: 'audit' } })).cached, false, 'filtro diferente é outra chave')
})

test('no máximo maxRuns Blenders simultâneos; cancelar na fila não executa', { skip: !posix }, async () => {
  const log = path.join(root, 'spans.log')
  const exe = fake('busy-blender', `fs.appendFileSync(${JSON.stringify(log)}, 'S' + Date.now() + '\\n'); setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, 'E' + Date.now() + '\\n'); ${reply('ok')} }, 300)`)
  const files = [0, 1, 2, 3].map(i => { const p = path.join(root, `c${i}.blend`); fs.writeFileSync(p, 'BLENDER-v400'); return p })
  const runs = blenderStats.runs
  await Promise.all(files.map(file => inspectBlend({ exe, version: '4.1.1', file, root, args: { mode: 'summary' } })))
  let cur = 0, peak = 0
  for (const l of fs.readFileSync(log, 'utf8').trim().split('\n').sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || (a[0] === 'E' ? -1 : 1))) peak = Math.max(peak, cur += l[0] === 'S' ? 1 : -1)
  assert.equal(peak, BLENDER_LIMITS.maxRuns); assert.equal(blenderStats.runs, runs + 4)
  const ac = new AbortController()
  const queued = files.map((file, i) => inspectBlend({ exe, version: '4.1.1', file, root, args: { mode: 'x' + i }, signal: i === 3 ? ac.signal : undefined }))
  ac.abort()
  const settled = await Promise.allSettled(queued)
  assert.equal(settled[3].status, 'rejected'); assert.equal(blenderStats.runs, runs + 7)
})

test('script empacotado ausente dá erro explícito', async () => {
  setBlenderScriptRoots([path.join(root, 'nope')])
  try { await assert.rejects(inspectBlend({ exe: 'x', version: '4.0', file: path.join(root, 'g.blend'), root, args: { mode: 'summary' } }), /Script de inspeção do Blender ausente/) }
  finally { setBlenderScriptRoots([script]) }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fieldOf, fieldText, nodePath, parseUnityYaml, rawAt, refOf, unityIndex, unityLog, unityProject, unityTestResults, unityTree, valueOf, yamlValue } from './unity.ts'

const Y = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n'

test('parser YAML: documentos, stripped, fileIDs de 64 bits, chaves com espaço e strings multilinha', () => {
  const y = parseUnityYaml(`${Y}--- !u!20 &-4216859302048453862
Camera:
  m_ObjectHideFlags: 0
  field of view: 60
  m_Text: 'It''s long and
    wraps: here'

  m_Path: "C:\\\\Games\\\\x \\u00e9\\
    \\ fim"
  m_List:
  - 1
  - {fileID: 2}
  m_Empty:
--- !u!4 &9223372036854775807 stripped
Transform:
  m_PrefabInstance: {fileID: 5}
garbage at column zero
`)
  assert.deepEqual(y.docs.map(d => [d.classId, d.id, d.type, d.stripped]), [[20, '-4216859302048453862', 'Camera', false], [4, '9223372036854775807', 'Transform', true]])
  const cam = y.docs[0]
  assert.deepEqual(cam.fields.map(f => f.key), ['m_ObjectHideFlags', 'field of view', 'm_Text', 'm_Path', 'm_List', 'm_Empty'])
  assert.equal(valueOf(y, cam, 'field of view'), '60')
  assert.equal(valueOf(y, cam, 'm_Text'), "It's long and wraps: here")
  assert.equal(valueOf(y, cam, 'm_Path'), 'C:\\Games\\x é fim')
  assert.deepEqual(valueOf(y, cam, 'm_List'), ['1', { fileID: '2' }])
  assert.equal(valueOf(y, cam, 'm_Empty'), '')
  assert.deepEqual(refOf(y, y.docs[1], 'm_PrefabInstance'), { fileID: '5', guid: undefined, type: undefined })
  assert.match(y.warnings.join(), /1 linha\(s\) fora do formato/)
  assert.throws(() => parseUnityYaml('fileFormatVersion: 2\nguid: abc\n'), /use unity_refs/)
})

test('valor genérico: listas estilo Unity, mapas aninhados, fluxo e itens vazios; rawAt segue caminhos a.b', () => {
  const lines = `  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 0}
    m_Modifications:
    - target: {fileID: 1, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Boss
      objectReference: {fileID: 0}
    - target: {fileID: 2, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Colors.Array.data[0]
      value:
      objectReference: {fileID: 0}
    m_RemovedComponents: []
    m_Layers:
    -
    - Water
    m_Nested:
      inner:
        deep: [1, 2]`.split('\n')
  assert.deepEqual(yamlValue(lines), {
    serializedVersion: '3', m_TransformParent: { fileID: '0' },
    m_Modifications: [
      { target: { fileID: '1', guid: '0123456789abcdef0123456789abcdef', type: '3' }, propertyPath: 'm_Name', value: 'Boss', objectReference: { fileID: '0' } },
      { target: { fileID: '2', guid: '0123456789abcdef0123456789abcdef', type: '3' }, propertyPath: 'm_Colors.Array.data[0]', value: '', objectReference: { fileID: '0' } }
    ],
    m_RemovedComponents: [], m_Layers: ['', 'Water'], m_Nested: { inner: { deep: ['1', '2'] } }
  })
  const y = parseUnityYaml(`${Y}--- !u!1001 &5\nPrefabInstance:\n${lines.join('\n')}\n  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}\n`)
  const d = y.docs[0]
  assert.equal(fieldText(y, rawAt(y, d, 'm_Modification.m_Modifications')!).split('\n').length, 9)
  assert.equal(fieldText(y, rawAt(y, d, 'm_Modification.m_Nested.inner.deep')!), '        deep: [1, 2]')
  assert.equal(rawAt(y, d, 'm_Modification.nope'), undefined)
  const mat = parseUnityYaml(`${Y}--- !u!21 &2100000\nMaterial:\n  m_SavedProperties:\n    m_Floats:\n    - _Cutoff: 0.5\n    - _Glossiness: 0.25\n    m_Colors:\n    - _Color: {r: 1, g: 1, b: 1, a: 1}\n  m_Broken: [}\n`)
  assert.equal(fieldText(mat, rawAt(mat, mat.docs[0], 'm_SavedProperties.m_Floats._Glossiness')!), '    - _Glossiness: 0.25')
  assert.equal(fieldText(mat, rawAt(mat, mat.docs[0], 'm_SavedProperties.m_Floats')!), '    m_Floats:\n    - _Cutoff: 0.5\n    - _Glossiness: 0.25')
  assert.equal(valueOf(mat, mat.docs[0], 'm_Broken'), '[}')
  assert.equal(fieldText(y, fieldOf(d, 'm_SourcePrefab')!), '  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}')
})

const go = (id: string, name: string, comps: string[]) => `--- !u!1 &${id}\nGameObject:\n  m_Component:\n${comps.map(c => `  - component: {fileID: ${c}}`).join('\n')}\n  m_Name: ${name}\n  m_IsActive: 1\n`
const tr = (id: string, g: string, father: string, children: string[], order?: number) => `--- !u!4 &${id}\nTransform:\n  m_GameObject: {fileID: ${g}}\n  m_Children:${children.length ? '\n' + children.map(c => `  - {fileID: ${c}}`).join('\n') : ' []'}\n  m_Father: {fileID: ${father}}\n${order === undefined ? '' : `  m_RootOrder: ${order}\n`}`

test('hierarquia: m_RootOrder antigo, variante de prefab com objeto adicionado sob filho interno, ciclos e órfãos', () => {
  const guid = 'aaaabbbbccccddddeeeeffff00001111'
  const y = parseUnityYaml(`${Y}${go('1', 'B', ['2'])}${tr('2', '1', '0', ['4'], 1)}${go('3', 'A', ['4x'])}${tr('4', '3', '2', [], 0)}${go('5', 'Z', ['6'])}${tr('6', '5', '0', [], 0)}--- !u!1001 &10
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 0}
    m_Modifications:
    - target: {fileID: 7, guid: ${guid}, type: 3}
      propertyPath: m_RootOrder
      value: 2
      objectReference: {fileID: 0}
    - target: {fileID: 8, guid: ${guid}, type: 3}
      propertyPath: m_IsActive
      value: 0
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}
--- !u!4 &11 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 99, guid: ${guid}, type: 3}
  m_PrefabInstance: {fileID: 10}
${go('12', 'Added', ['13'])}${tr('13', '12', '11', [])}${go('20', 'Loop1', ['21'])}${tr('21', '20', '23', [])}${go('22', 'Loop2', ['23'])}${tr('23', '22', '21', [])}${go('30', 'NoTransform', [])}--- !u!1001 &40
Prefab:
  m_ParentPrefab: {fileID: 0}
  m_RootGameObject: {fileID: 1}
  m_IsPrefabAsset: 1
`)
  const t = unityTree(y)
  assert.deepEqual(t.roots.map(n => n.name || '&' + n.id).filter(n => ['Z', 'B', '&10'].includes(n)), ['Z', 'B', '&10'])
  assert.equal(nodePath(t.owner.get('13')!), '&10/Added')
  const pi = t.owner.get('10')!
  assert.equal(pi.kind, 'prefab'); assert.equal(pi.source?.guid, guid); assert.equal(pi.mods, 2); assert.equal(pi.active, true, 'm_IsActive de outro alvo não conta como raiz inativa')
  assert.equal(nodePath(t.owner.get('4')!), 'B/A')
  assert.ok(t.warnings.some(w => /Ciclo/.test(w))); assert.ok(t.warnings.some(w => /NoTransform.*sem Transform/.test(w)))
  assert.ok(!t.nodes.some(n => n.id === '40'), 'Prefab antigo (marcador do asset) não é instância')
  assert.equal(t.stripped, 1)
})

test('log Unity: timestamps, caminhos Windows/CI, pacotes em cache, sucesso de build e agrupamento', () => {
  const log = `2026-09-30T10:00:00.000Z|0x1a2b|C:\\ci\\proj\\Assets\\Scripts\\A.cs(3,9): error CS1002: ; expected
2026-09-30T10:00:00.100Z|0x1a2b|C:\\ci\\proj\\Assets\\Scripts\\A.cs(3,9): error CS1002: ; expected
Library/PackageCache/com.unity.ugui@1.0.0/Runtime/X.cs(1,1): warning CS0618: 'Obsolete' is obsolete

MissingReferenceException: The object of type 'GameObject' has been destroyed but you are still trying to access it.
UnityEngine.GameObject.get_transform () (at <abc>:0)
Enemy.LateUpdate () (at Assets/Scripts/Enemy.cs:40)

Build completed with a result of 'Succeeded' in 12 seconds (12000 ms)
Exiting batchmode successfully now!
`
  const r = unityLog(log)
  const cs = r.items.find(d => d.code === 'CS1002')!
  assert.equal(cs.file, 'Assets/Scripts/A.cs'); assert.equal(cs.count, 2); assert.deepEqual(cs.lines, [1, 2])
  assert.equal(r.items.find(d => d.code === 'CS0618')!.file, 'Library/PackageCache/com.unity.ugui@1.0.0/Runtime/X.cs')
  const ex = r.items.find(d => d.kind === 'exceção')!
  assert.equal(ex.code, 'MissingReferenceException'); assert.equal(ex.file, 'Assets/Scripts/Enemy.cs'); assert.equal(ex.line, 40); assert.equal(ex.stack.length, 2)
  assert.deepEqual(r.items.filter(d => d.severity === 'info').map(d => d.kind), ['build', 'batchmode'])
  assert.deepEqual(unityLog('just noise\nnothing here\n').items, [])
})

test('log sem linhas em branco: cada pilha leva só sua mensagem, sem engolir erros vizinhos', () => {
  const r = unityLog(`Refreshing native plugins compatible for Editor in 1.23 ms
Assets/X.cs(1,2): error CS0246: The type or namespace name 'Foo' could not be found
Player died unexpectedly
UnityEngine.Debug:LogError (object)
Game:Die () (at Assets/Game.cs:5)
UnityException: Tag: Foo is not defined.
Some.Other () (at Assets/Other.cs:9)
ArgumentException: standalone header`)
  assert.deepEqual(r.items.map(d => [d.kind, d.message, d.file ?? null]), [
    ['compilação', "The type or namespace name 'Foo' could not be found", 'Assets/X.cs'],
    ['LogError', 'Player died unexpectedly', 'Assets/Game.cs'],
    ['exceção', 'Tag: Foo is not defined.', 'Assets/Other.cs'],
    ['exceção', 'standalone header', null]
  ])
})

test('NUnit: entidades fora de CDATA, suites sem falha própria ignoradas, XML inválido recusado', () => {
  const r = unityTestResults(`<test-run result="Passed" total="1" passed="1" failed="0" skipped="0" duration="0.5"><test-suite result="Passed"><test-case fullname="A &amp; B" result="Passed"/></test-suite></test-run>`)
  assert.deepEqual([r.result, r.total, r.passed, r.duration, r.items.length], ['Passed', 1, 1, 0.5, 0])
  assert.throws(() => unityTestResults('<assemblies/>'), /NUnit/)
})

test('metadados: arquivos ausentes viram avisos; Built-in, Mixed e asmdef de teste por optionalUnityReferences', () => {
  const files: Record<string, string> = {
    'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2019.4.40f1\n',
    'ProjectSettings/EditorSettings.asset': `${Y}--- !u!159 &1\nEditorSettings:\n  m_SerializationMode: 0\n`,
    'ProjectSettings/GraphicsSettings.asset': `${Y}--- !u!30 &1\nGraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 0}\n`,
    'Packages/manifest.json': '{ not json',
    'Assets/T/Old.asmdef': JSON.stringify({ name: 'Old.Tests', optionalUnityReferences: ['TestAssemblies'] })
  }
  const read = (rel: string) => files[rel] ?? (() => { const e: any = Error('nope'); e.code = 'ENOENT'; throw e })()
  const p = unityProject(read, Object.keys(files))
  assert.equal(p.editor, '2019.4.40f1'); assert.equal(p.serialization, 0); assert.equal(p.pipeline.kind, 'Built-in')
  assert.deepEqual(p.asmdefs, [{ name: 'Old.Tests', path: 'Assets/T/Old.asmdef', test: true, editor: false }])
  assert.ok(p.warnings.some(w => /manifest\.json inválido/.test(w))); assert.ok(p.warnings.some(w => /ProjectSettings\.asset ausente/.test(w)))
  assert.equal(p.input, null)
})

test('índice: segue regras de import do Unity, registra pastas internas, não segue links nem lê credenciais', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-unity-index-'))
  try {
    const put = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body) }
    const g = '0123456789abcdef0123456789abcdef'
    put('Assets/A.prefab.meta', `fileFormatVersion: 2\nguid: ${g}\n`)
    put('Assets/Build/Uses.asset', `x: {fileID: 1, guid: ${g}, type: 3}\n`)
    put('Assets/Samples~/Hidden.asset', `x: {guid: ${g}}\n`)
    put('Assets/.hidden/H.asset', `x: {guid: ${g}}\n`)
    put('Assets/Sub/Temp/T.asset', `x: {guid: ${g}}\n`)
    put('Assets/key.keystore', g)
    fs.symlinkSync(path.join(root, 'Assets', 'Build'), path.join(root, 'Assets', 'link'), 'dir')
    const idx = unityIndex(root, ['Temp', 'Library'], true)
    assert.equal(idx.byGuid.get(g), 'Assets/A.prefab')
    assert.deepEqual([...idx.files.keys()].filter(r => idx.files.get(r)!.refs?.get(g)).sort(), ['Assets/A.prefab.meta', 'Assets/Build/Uses.asset'])
    assert.deepEqual(idx.hidden, ['Assets/Sub/Temp']); assert.equal(idx.links, 1)
    assert.ok(![...idx.files.keys()].some(r => /keystore|~|\.hidden/.test(r)))
    put('Assets/Build/New.asset', `y: {guid: ${g}}\n`)
    assert.ok(unityIndex(root, ['Temp', 'Library'], true).files.get('Assets/Build/New.asset')?.refs?.get(g), 'usages revarre sem esperar TTL')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

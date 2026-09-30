import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openGrant } from './consent.ts'
import { openDb } from './db.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import type { ToolCtx } from './taskContext.ts'
import { createTask } from './tasks.ts'
import { UNITY_TOOLS, callUnityTool } from './unityTools.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-unity-tools-'))
const cwd = path.join(root, 'project'), outside = path.join(root, 'outside')
const put = (rel: string, body: string | Buffer) => { const p = path.join(cwd, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
const Y = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n'
const meta = (rel: string, guid: string, importer = 'MonoImporter') => put(rel + '.meta', `fileFormatVersion: 2\nguid: ${guid}\n${importer}:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`)
const G = {
  player: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', spawner: 'b2c3d4e5f60718293a4b5c6d7e8f90a1', config: 'c3d4e5f60718293a4b5c6d7e8f90a1b2', enemy: 'd4e5f60718293a4b5c6d7e8f90a1b2c3',
  red: 'e5f60718293a4b5c6d7e8f90a1b2c3d4', urp: 'f60718293a4b5c6d7e8f90a1b2c3d4e5', scene: '0718293a4b5c6d7e8f90a1b2c3d4e5f6', data: '18293a4b5c6d7e8f90a1b2c3d4e5f607', orphan: '293a4b5c6d7e8f90a1b2c3d4e5f60718'
}
fs.mkdirSync(outside, { recursive: true })
put('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.20f1\nm_EditorVersionWithRevision: 2022.3.20f1 (61c2feb0970d)\n')
put('ProjectSettings/ProjectSettings.asset', `${Y}--- !u!129 &1
PlayerSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 26
  companyName: Acme Games
  productName: Orbit Runner
  defaultCursor: {fileID: 0}
  bundleVersion: 0.4.2
  scriptingDefineSymbols:
    Standalone: ENABLE_CHEATS;USE_STEAM
  scriptingBackend:
    Standalone: 1
  activeInputHandler: 1
`)
put('ProjectSettings/EditorSettings.asset', `${Y}--- !u!159 &1\nEditorSettings:\n  m_ObjectHideFlags: 0\n  serializedVersion: 11\n  m_SerializationMode: 2\n  m_LineEndingsForNewScripts: 0\n`)
put('ProjectSettings/GraphicsSettings.asset', `${Y}--- !u!30 &1\nGraphicsSettings:\n  m_ObjectHideFlags: 0\n  serializedVersion: 15\n  m_CustomRenderPipeline: {fileID: 11400000, guid: ${G.urp}, type: 2}\n`)
put('ProjectSettings/EditorBuildSettings.asset', `${Y}--- !u!1045 &1
EditorBuildSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Scenes:
  - enabled: 1
    path: Assets/Scenes/Main.unity
    guid: ${G.scene}
  - enabled: 0
    path: Assets/Scenes/Sandbox.unity
    guid: 00000000000000000000000000000001
  m_configObjects: {}
`)
put('ProjectSettings/TagManager.asset', `${Y}--- !u!78 &1
TagManager:
  serializedVersion: 2
  tags:
  - Enemy
  - Pickup
  layers:
  - Default
  - TransparentFX
  - Ignore Raycast
  -
  - Water
  - UI
  -
  -
  - Ground
  - Enemies
  m_SortingLayers:
  - name: Default
    uniqueID: 0
    locked: 0
  - name: Foreground
    uniqueID: 12345
    locked: 0
`)
put('Packages/manifest.json', JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '14.0.10', 'com.unity.inputsystem': '1.7.0', 'com.unity.test-framework': '1.1.33', 'com.acme.tools': 'file:../acme-tools', 'com.x.net': 'https://user:s3cret@github.com/x/net.git#v1', 'com.unity.modules.audio': '1.0.0', 'com.unity.modules.physics': '1.0.0' } }, null, 2))
put('Packages/com.orbit.embedded/package.json', '{"name":"com.orbit.embedded","version":"0.1.0"}')
put('Assets/Scripts/PlayerController.cs', 'using UnityEngine;\npublic class PlayerController : MonoBehaviour { public float speed = 5; public Transform target; public GameObject weaponPrefab; }\n'); meta('Assets/Scripts/PlayerController.cs', G.player)
put('Assets/Scripts/Spawner.cs', 'using UnityEngine;\npublic class Spawner : MonoBehaviour { public GameObject prefab; }\n'); meta('Assets/Scripts/Spawner.cs', G.spawner)
put('Assets/Scripts/GameConfig.cs', 'using UnityEngine;\n[CreateAssetMenu] public class GameConfig : ScriptableObject { public int maxHealth; }\n'); meta('Assets/Scripts/GameConfig.cs', G.config)
put('Assets/Scripts/Game.asmdef', JSON.stringify({ name: 'Game', references: ['Unity.InputSystem'] })); meta('Assets/Scripts/Game.asmdef', '3a4b5c6d7e8f90a1b2c3d4e5f6071829', 'AssemblyDefinitionImporter')
put('Assets/Tests/Game.Tests.asmdef', JSON.stringify({ name: 'Game.Tests', references: ['Game', 'UnityEngine.TestRunner'], includePlatforms: ['Editor'], defineConstraints: ['UNITY_INCLUDE_TESTS'] }))
put('Assets/Materials/Red.mat', `${Y}--- !u!21 &2100000
Material:
  serializedVersion: 8
  m_ObjectHideFlags: 0
  m_Name: Red
  m_Shader: {fileID: 4800000, guid: 933532a4fcc9baf4fa0491de14d08ed7, type: 3}
  m_ValidKeywords: []
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _BaseMap:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _Smoothness: 0.5
    m_Colors:
    - _BaseColor: {r: 1, g: 0, b: 0, a: 1}
`); meta('Assets/Materials/Red.mat', G.red, 'NativeFormatImporter')
put('Assets/Settings/URP.asset', `${Y}--- !u!114 &11400000\nMonoBehaviour:\n  m_ObjectHideFlags: 0\n  m_Script: {fileID: 11500000, guid: 15686ae9be4aa3a4db79dbba4b2c9e04, type: 3}\n  m_Name: URP\n  m_EditorClassIdentifier: \n  k_AssetVersion: 11\n`); meta('Assets/Settings/URP.asset', G.urp, 'NativeFormatImporter')
put('Assets/Data/Config.asset', `${Y}--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 0}
  m_Enabled: 1
  m_EditorHideFlags: 0
  m_Script: {fileID: 11500000, guid: ${G.config}, type: 3}
  m_Name: Config
  m_EditorClassIdentifier:
  maxHealth: 100
  intro: 'It''s a long intro line that Unity wraps
    onto a second line'
  levels:
  - name: Forest
    enemy: {fileID: 100100000, guid: ${G.enemy}, type: 3}
  - name: Cave
    enemy: {fileID: 0}
`); meta('Assets/Data/Config.asset', G.data, 'NativeFormatImporter')
const enemyPrefab = `${Y}--- !u!1 &100100
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 400000}
  - component: {fileID: 2300000}
  m_Layer: 9
  m_Name: Enemy
  m_TagString: Enemy
  m_IsActive: 1
--- !u!4 &400000
Transform:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100100}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children: []
  m_Father: {fileID: 0}
--- !u!23 &2300000
MeshRenderer:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100100}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${G.red}, type: 2}
`
put('Assets/Prefabs/Enemy.prefab', enemyPrefab); meta('Assets/Prefabs/Enemy.prefab', G.enemy, 'PrefabImporter')
const go = (id: string, name: string, comps: string[], extra = '', active = 1, layer = 0) => `--- !u!1 &${id}
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  serializedVersion: 6
  m_Component:
${comps.map(c => `  - component: {fileID: ${c}}`).join('\n')}
  m_Layer: ${layer}
  m_Name: ${name}
  m_TagString: Untagged
  m_Icon: {fileID: 0}
  m_NavMeshLayer: 0
  m_StaticEditorFlags: 0
  m_IsActive: ${active}
${extra}`
const tr = (id: string, goId: string, father: string, children: string[], pos = '{x: 0, y: 0, z: 0}', type = 'Transform', cls = 4) => `--- !u!${cls} &${id}
${type}:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: ${goId}}
  serializedVersion: 2
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: ${pos}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_ConstrainProportionsScale: 0
  m_Children:${children.length ? '\n' + children.map(c => `  - {fileID: ${c}}`).join('\n') : ' []'}
  m_Father: {fileID: ${father}}
  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}
`
const mb = (id: string, goId: string, script: string, fields: string, enabled = 1) => `--- !u!114 &${id}
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: ${goId}}
  m_Enabled: ${enabled}
  m_EditorHideFlags: 0
  m_Script: ${script}
  m_Name:
  m_EditorClassIdentifier:
${fields}`
const sceneText = `${Y}--- !u!29 &1
OcclusionCullingSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 2
--- !u!104 &2
RenderSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 9
  m_Fog: 0
${go('100', 'Main Camera', ['101', '102', '103', '104'])}${tr('101', '100', '0', [], '{x: 0, y: 1, z: -10}')}--- !u!20 &102
Camera:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  field of view: 60
  orthographic: 0
--- !u!81 &103
AudioListener:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100}
  m_Enabled: 1
${mb('104', '100', '{fileID: 11500000, guid: a79441f348de89743a2939f4d699eac1, type: 3}', '  m_RenderShadows: 1\n')}${go('200', 'Player', ['201', '202', '203'], '', 1, 8)}${tr('201', '200', '0', ['301', '6000'], '{x: 2, y: 0, z: 0}')}--- !u!65 &202
BoxCollider:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 200}
  m_Material: {fileID: 0}
  m_IsTrigger: 0
  m_Enabled: 1
  serializedVersion: 3
  m_Size: {x: 1, y: 2, z: 1}
  m_Center: {x: 0, y: 1, z: 0}
${mb('203', '200', `{fileID: 11500000, guid: ${G.player}, type: 3}`, `  speed: 7.5\n  target: {fileID: 301}\n  weaponPrefab: {fileID: 100100000, guid: ${G.enemy}, type: 3}\n  greeting: "Ol\\xE1, jogador"\n`)}${go('300', 'Weapon', ['301', '302', '303'], '', 0)}${tr('301', '300', '201', [])}--- !u!23 &302
MeshRenderer:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 300}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${G.red}, type: 2}
--- !u!33 &303
MeshFilter:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 300}
  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}
${go('400', 'Canvas', ['401', '402', '403', '404'], '', 1, 5)}${tr('401', '400', '0', [], '{x: 0, y: 0, z: 0}', 'RectTransform', 224)}--- !u!223 &402
Canvas:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 400}
  m_Enabled: 1
  m_RenderMode: 0
${mb('403', '400', '{fileID: 11500000, guid: fe87c0e1cc204ed48ad3b37840f39efc, type: 3}', '  m_Color: {r: 1, g: 1, b: 1, a: 1}\n', 0)}${mb('404', '400', '{fileID: 0}', '  oldField: 3\n')}--- !u!1001 &5000
PrefabInstance:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 201}
    m_Modifications:
    - target: {fileID: 100200, guid: ${G.enemy}, type: 3}
      propertyPath: m_Name
      value: Renamed Inner Child
      objectReference: {fileID: 0}
    - target: {fileID: 100100, guid: ${G.enemy}, type: 3}
      propertyPath: m_Name
      value: Enemy Boss
      objectReference: {fileID: 0}
    - target: {fileID: 400000, guid: ${G.enemy}, type: 3}
      propertyPath: m_LocalPosition.x
      value: 3
      objectReference: {fileID: 0}
    - target: {fileID: 2300000, guid: ${G.enemy}, type: 3}
      propertyPath: m_Materials.Array.data[0]
      value:
      objectReference: {fileID: 2100000, guid: ${G.red}, type: 2}
    m_RemovedComponents: []
    m_RemovedGameObjects: []
    m_AddedGameObjects: []
    m_AddedComponents:
    - targetCorrespondingSourceObject: {fileID: 100100, guid: ${G.enemy}, type: 3}
      insertIndex: -1
      addedObject: {fileID: 6002}
  m_SourcePrefab: {fileID: 100100000, guid: ${G.enemy}, type: 3}
--- !u!4 &6000 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 400000, guid: ${G.enemy}, type: 3}
  m_PrefabInstance: {fileID: 5000}
  m_PrefabAsset: {fileID: 0}
--- !u!1 &6001 stripped
GameObject:
  m_CorrespondingSourceObject: {fileID: 100100, guid: ${G.enemy}, type: 3}
  m_PrefabInstance: {fileID: 5000}
  m_PrefabAsset: {fileID: 0}
--- !u!54 &6002
Rigidbody:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 6001}
  serializedVersion: 4
  m_Mass: 1
${go('700', 'Spawner', ['701', '702'])}${tr('701', '700', '0', [])}${mb('702', '700', `{fileID: 11500000, guid: ${G.spawner}, type: 3}`, `  prefab: {fileID: 100100000, guid: ${G.enemy}, type: 3}\n`)}${go('800', 'Spawner', ['801'])}${tr('801', '800', '0', [])}--- !u!1660057539 &9223372036854775807
SceneRoots:
  m_ObjectHideFlags: 0
  m_Roots:
  - {fileID: 101}
  - {fileID: 201}
  - {fileID: 401}
  - {fileID: 701}
  - {fileID: 801}
`
put('Assets/Scenes/Main.unity', sceneText); meta('Assets/Scenes/Main.unity', G.scene, 'DefaultImporter')
// Cena grande: 12 raízes × cadeia de 30 níveis, cada nó com um MonoBehaviour.
let big = Y, n = 10_000
for (let r = 0; r < 12; r++) {
  let father = '0'
  for (let d = 0; d < 30; d++) {
    const g = String(n++), t = String(n++), m = String(n++)
    big += go(g, `Node_${r}_${d}`, [t, m]) + tr(t, g, father, d < 29 ? [String(n + 1)] : []) + mb(m, g, `{fileID: 11500000, guid: ${G.player}, type: 3}`, `  speed: ${d}\n`)
    father = t
  }
}
put('Assets/Scenes/Big.unity', big)
put('Assets/Plugins/Android/release.keystore', 'KEYSTORE_SECRET')
put('Library/PackageCache/com.foo@1.0/Foo.cs.meta', `fileFormatVersion: 2\nguid: ${G.orphan}\n`)
put('Library/PackageCache/com.foo@1.0/uses.asset', `${Y}--- !u!114 &1\nMonoBehaviour:\n  x: {fileID: 1, guid: ${G.enemy}, type: 3}\n`)
put('Assets/Art/hero.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
put('Assets/Art/Binary.asset', Buffer.from([0x00, 0x01, 0x02, 0x03]))

const db = openDb(path.join(root, 'test.db')), taskId = createTask(db, cwd, 'Unity')
const group = { id: 'unity', name: 'Unity', color: '#88aabb', games: [cwd], open: true, unity: { enabled: true, executable: 'unity' } }
const setGroups = (groups: any[] = [group]) => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('projectGroups',?)").run(JSON.stringify(groups))
setGroups()
const context = (scope: string[] = []): ToolCtx => {
  const lineage = `del:${taskId}`
  return { taskId, lineage, auth: openGrant(db, { taskId, recipient: { logicalId: lineage, provider: 'codex', profile: '', workspace: cwd, scope } }), cwd, scope, role: 'child' }
}
const ctx = context()
const call = (name: string, args: any = {}, c = ctx, chars = 6000, organizerId = 'unity') => callUnityTool(db, { ...DEFAULT_LIMITS, queryChars: chars }, c, organizerId, name, args)
const ok = (name: string, args: any = {}, c = ctx, chars = 6000) => { const r = call(name, args, c, chars); assert.equal(r.isError, false, r.text); return r.text }
const content = (response: string) => response.split('\n').slice(2).join('\n')
const hash = (response: string) => /hash ([a-f0-9]{64})/.exec(response)![1]
const next = (response: string) => /próximo offset (\d+)/.exec(response)?.[1]

test.after(() => {
  db.close()
  assert.ok(path.basename(root).startsWith('gpd-unity-tools-'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('quatro esquemas curtos; argumentos fora do schema e organizador inválido são recusados', () => {
  assert.deepEqual(UNITY_TOOLS.map(t => t.name), ['unity_project', 'unity_asset', 'unity_refs', 'unity_diagnostics'])
  assert.ok(JSON.stringify(UNITY_TOOLS).length < 2400, String(JSON.stringify(UNITY_TOOLS).length))
  assert.match(call('unity_project', { game: cwd }).text, /Argumento não permitido/)
  assert.equal(call('unity_run').isError, true)
  assert.equal(call('unity_project', {}, ctx, 6000, 'other').isError, true)
  assert.equal(call('unity_project', {}, { ...ctx, cwd: outside }).isError, true)
  try { setGroups([{ ...group, unity: { enabled: false, executable: 'unity' } }]); assert.equal(call('unity_project').isError, true) } finally { setGroups() }
})

test('projeto: metadados compactos e acionáveis, sem segredos em URLs', () => {
  const t = ok('unity_project')
  for (const re of [/Unity 2022\.3\.20f1 \(rev 61c2feb0970d\) · Orbit Runner · Acme Games · versão 0\.4\.2/, /serialização: Force Text · input: Input System \(novo\)/, /render: URP · asset Assets\/Settings\/URP\.asset/,
    /backend: Standalone=IL2CPP/, /defines: Standalone=ENABLE_CHEATS;USE_STEAM/, /pacotes \(6 \+ 2 com\.unity\.modules\.\*\)/, /com\.acme\.tools@file:\.\.\/acme-tools \[local\]/, /com\.orbit\.embedded \[embedded\]/, /\[git\]/,
    /✓ Assets\/Scenes\/Main\.unity; ✗ Assets\/Scenes\/Sandbox\.unity/, /Game \(Assets\/Scripts\/Game\.asmdef\); Game\.Tests \[teste\] \[Editor\]/, /tags: Enemy, Pickup · layers do usuário: 8=Ground, 9=Enemies · sorting: Default, Foreground/, /arquivos em Assets: cs 3, unity 2, prefab 1, asset 3, mat 1, asmdef 2/]) assert.match(t, re)
  assert.doesNotMatch(t, /s3cret|com\.unity\.modules\.audio|KEYSTORE/)
  assert.ok(t.length < 2000, String(t.length))
  put('ProjectSettings/EditorSettings.asset', `${Y}--- !u!159 &1\nEditorSettings:\n  m_SerializationMode: 0\n`)
  try { assert.match(ok('unity_project'), /Mixed ⚠/) } finally { put('ProjectSettings/EditorSettings.asset', `${Y}--- !u!159 &1\nEditorSettings:\n  m_SerializationMode: 2\n`) }
})

test('asset padrão: hierarquia compacta com scripts, pacotes, prefabs, missing script e stripped', () => {
  const t = ok('unity_asset', { path: 'Assets/Scenes/Main.unity' })
  assert.match(t, /\d+ doc\(s\), 6 GameObject\(s\), 1 prefab\(s\) instanciada\(s\), 2 stripped/)
  assert.match(t, /outros docs: OcclusionCullingSettings, RenderSettings/)
  const tree = t.split('\n').filter(l => /&\d+/.test(l) && !/^(?:scripts|Próximo)/.test(l)).map(l => l.replace(/ \[.*$/, ''))
  assert.deepEqual(tree.slice(0, 7), ['Main Camera &100', 'Player &200', '  Weapon &300 (inativo)', '  Enemy Boss &5000 ⇒ prefab Assets/Prefabs/Enemy.prefab · 4 mod(s)', 'Canvas &400', 'Spawner &700', 'Spawner &800'])
  assert.match(t, /Main Camera &100 \[Camera, AudioListener, URP\.UniversalAdditionalCameraData\]/)
  assert.match(t, /Player &200 \[BoxCollider, PlayerController\]/)
  assert.match(t, /Enemy Boss &5000 ⇒ prefab Assets\/Prefabs\/Enemy\.prefab · 4 mod\(s\) \[\+Rigidbody\]/)
  assert.match(t, /Canvas &400 \[RectTransform, Canvas, UI\.Image\(desativado\), MonoBehaviour\(script ausente\)\]/)
  assert.match(t, /scripts: PlayerController=Assets\/Scripts\/PlayerController\.cs; Spawner=Assets\/Scripts\/Spawner\.cs/)
  assert.match(t, /conteúdo interno não expandido/)
  assert.ok(t.length < sceneText.length / 4, `${t.length} vs ${sceneText.length}`)
})

test('object seleciona por caminho ou fileID; ambiguidade e ausência orientam o próximo passo', () => {
  const t = ok('unity_asset', { path: 'Assets/Scenes/Main.unity', object: 'Player' })
  assert.match(t, /Player &200 · GameObject · tag Untagged · layer 8/)
  assert.match(t, /Transform &201 pos\(2, 0, 0\)/)
  assert.match(t, /BoxCollider &202 · m_Material, m_IsTrigger, m_Size, m_Center/)
  assert.match(t, /PlayerController &203 · speed, target, weaponPrefab, greeting/)
  assert.match(t, /Player\/Weapon &300 · GameObject \(inativo\)/)
  assert.match(t, /Player\/Enemy Boss &5000 · PrefabInstance ⇒ Assets\/Prefabs\/Enemy\.prefab/)
  assert.match(t, /mod m_LocalPosition\.x = 3 \(alvo 400000\)/)
  assert.match(t, /mod m_Materials\.Array\.data\[0\] → Assets\/Materials\/Red\.mat/)
  assert.match(t, /m_AddedComponents: 1/)
  assert.doesNotMatch(t, /Main Camera|Spawner/)
  assert.equal(ok('unity_asset', { path: 'Assets/Scenes/Main.unity', object: '&203' }).split('\n')[2], t.split('\n')[2])
  assert.match(call('unity_asset', { path: 'Assets/Scenes/Main.unity', object: 'Weapon' }).text, /candidatos: Player\/Weapon &300/)
  assert.match(call('unity_asset', { path: 'Assets/Scenes/Main.unity', object: 'Spawner' }).text, /ambíguo \(2 objetos\): &700, &800/)
  assert.match(call('unity_asset', { path: 'Assets/Scenes/Main.unity', object: 'Nope' }).text, /use find=/)
})

test('component + property devolve YAML bruto exato com legenda de GUIDs e fileIDs locais', () => {
  const s = ok('unity_asset', { path: 'Assets/Scenes/Main.unity', object: 'Player', component: 'PlayerController', property: 'speed' })
  assert.match(s, /Player · PlayerController &203 · speed · linhas \d+-\d+\n {2}speed: 7\.5/)
  const w = ok('unity_asset', { path: 'Assets/Scenes/Main.unity', component: '&203', property: 'weaponPrefab' })
  assert.match(w, /guid d4e5f60718293a4b5c6d7e8f90a1b2c3 → Assets\/Prefabs\/Enemy\.prefab/)
  const tg = ok('unity_asset', { path: 'Assets/Scenes/Main.unity', component: '&203', property: 'target' })
  assert.match(tg, /&301 → Player\/Weapon · Transform/)
  const mesh = ok('unity_asset', { path: 'Assets/Scenes/Main.unity', component: '&303', property: 'm_Mesh' })
  assert.match(mesh, /built-in: unity default resources/)
  const nested = ok('unity_asset', { path: 'Assets/Scenes/Main.unity', component: '&5000', property: 'm_Modification.m_TransformParent' })
  assert.match(nested, /m_TransformParent: \{fileID: 201\}\n[\s\S]*&201 → Player · Transform/)
  const whole = ok('unity_asset', { path: 'Assets/Scenes/Main.unity', object: 'Canvas', component: 'Canvas' })
  assert.match(whole, /--- !u!223 &402\nCanvas:\n {2}m_ObjectHideFlags: 0/)
  assert.match(call('unity_asset', { path: 'Assets/Scenes/Main.unity', component: 'BoxCollider' }).text, /exige object/)
  assert.match(call('unity_asset', { path: 'Assets/Scenes/Main.unity', object: 'Player', component: 'Rigidbody' }).text, /Disponíveis: gameobject &200, transform &201/i)
  assert.match(call('unity_asset', { path: 'Assets/Scenes/Main.unity', component: '&203', property: 'health' }).text, /default do script/)
  assert.match(ok('unity_asset', { path: 'Assets/Scenes/Main.unity', object: 'Player', property: 'm_Layer' }), /m_Layer: 8/)
})

test('find localiza nomes e tipos; assets não-cena listam docs e leem propriedades', () => {
  const f = ok('unity_asset', { path: 'Assets/Scenes/Main.unity', find: 'weapon' })
  assert.match(f, /1 ocorrência\(s\)/); assert.match(f, /Player\/Weapon &300 · nome/)
  assert.match(ok('unity_asset', { path: 'Assets/Scenes/Main.unity', find: 'playercontroller' }), /Player &200 · PlayerController &203/)
  assert.equal(call('unity_asset', { path: 'Assets/Scenes/Main.unity', find: 'x', object: 'Player' }).isError, true)
  const so = ok('unity_asset', { path: 'Assets/Data/Config.asset' })
  assert.match(so, /&11400000 GameConfig "Config" · maxHealth, intro, levels/)
  assert.match(so, /scripts: GameConfig=Assets\/Scripts\/GameConfig\.cs/)
  assert.match(ok('unity_asset', { path: 'Assets/Data/Config.asset', property: 'levels' }), /- name: Forest[\s\S]*guid d4e5f60718293a4b5c6d7e8f90a1b2c3 → Assets\/Prefabs\/Enemy\.prefab/)
  assert.match(ok('unity_asset', { path: 'Assets/Materials/Red.mat', property: 'm_SavedProperties.m_Floats' }), /m_Floats:\n {4}- _Smoothness: 0\.5$/m)
  assert.match(ok('unity_asset', { path: 'Assets/Materials/Red.mat' }), /&2100000 Material "Red" · m_Name, m_Shader, m_ValidKeywords, m_SavedProperties/)
  assert.match(ok('unity_asset', { path: 'Assets/Prefabs/Enemy.prefab' }), /Enemy &100100 \[MeshRenderer\]/)
})

test('cena grande cabe no orçamento com profundidade limitada; valores grandes são paginados sem perda', () => {
  const t = ok('unity_asset', { path: 'Assets/Scenes/Big.unity' })
  assert.ok(t.length <= 6000, String(t.length)); assert.equal(next(t), undefined, 'visão padrão numa página')
  assert.match(t, /Node_0_0 &10000 \[PlayerController\]/); assert.match(t, /\(\+\d+ abaixo\)/); assert.match(t, /profundidade limitada a \d+; object=&id expande/)
  const deep = ok('unity_asset', { path: 'Assets/Scenes/Big.unity', object: 'Node_3_0/Node_3_1' }, ctx, 2000)
  assert.ok(next(deep))
  let r = deep, joined = content(r), it = 0, h = hash(deep)
  while (next(r)) { r = ok('unity_asset', { path: 'Assets/Scenes/Big.unity', object: 'Node_3_0/Node_3_1', offset: Number(next(r)), hash: h }, ctx, 2000); joined += content(r); assert.ok(++it < 50) }
  assert.match(joined, /Node_3_0\/Node_3_1\/[^\n]*\/Node_3_29 &\d+/)
  assert.equal(call('unity_asset', { path: 'Assets/Scenes/Big.unity', object: 'Node_3_0/Node_3_1', offset: 10 }).isError, true)
})

test('refs: path↔guid, referências de saída e usos com objeto/campo; Library e binários fora', () => {
  const p = ok('unity_refs', { path: 'Assets/Prefabs/Enemy.prefab' })
  assert.match(p, /Assets\/Prefabs\/Enemy\.prefab → guid d4e5f60718293a4b5c6d7e8f90a1b2c3/)
  assert.match(p, /e5f60718293a4b5c6d7e8f90a1b2c3d4 → Assets\/Materials\/Red\.mat ×1/)
  assert.match(ok('unity_refs', { guid: G.player.toUpperCase() }), /→ Assets\/Scripts\/PlayerController\.cs/)
  assert.match(ok('unity_refs', { guid: G.orphan }), /não resolvido/)
  const u = ok('unity_refs', { path: 'Assets/Prefabs/Enemy.prefab', usages: true }, ctx, 20000)
  assert.match(u, /usos: 2 arquivo\(s\)/)
  assert.match(u, /Assets\/Data\/Config\.asset ×1 · GameConfig &11400000\.levels/)
  assert.match(u, /Assets\/Scenes\/Main\.unity ×\d+ · Player · PlayerController &203\.weaponPrefab; Player\/Enemy Boss · PrefabInstance &5000\.m_Modification\[m_Name\|m_LocalPosition\.x\|m_Materials\.Array\.data\[0\]\]/)
  assert.match(u, /Spawner · Spawner &702\.prefab/)
  assert.match(u, /não varridos: .*binário/); assert.match(u, /Zero usos não prova/)
  assert.doesNotMatch(u, /Library\/PackageCache\/com\.foo|Enemy\.prefab\.meta|&600[01]/)
  const s = ok('unity_refs', { path: 'Assets/Scripts/PlayerController.cs', usages: true })
  assert.match(s, /Assets\/Scenes\/Big\.unity ×360/); assert.match(s, /PlayerController &203\.m_Script/)
  assert.match(ok('unity_refs', { path: 'Assets/Art/new.png' }), /sem \.meta legível[\s\S]*Não crie/)
  fs.writeFileSync(path.join(cwd, 'Assets/Art/Binary.asset.meta'), 'fileFormatVersion: 2\nguid: 5555aaaa5555aaaa5555aaaa5555aaaa\n')
  assert.match(ok('unity_refs', { path: 'Assets/Art/Binary.asset' }), /guid 5555aaaa5555aaaa5555aaaa5555aaaa\nsaída: não lida \(Arquivo binário/)
  put('Assets/Scripts.meta', 'fileFormatVersion: 2\nguid: 6666bbbb6666bbbb6666bbbb6666bbbb\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n')
  const folder = ok('unity_refs', { path: 'Assets/Scripts' })
  assert.match(folder, /Assets\/Scripts → guid 6666bbbb6666bbbb6666bbbb6666bbbb/); assert.doesNotMatch(folder, /saída/)
  for (const bad of [{}, { path: 'x', guid: G.red }, { guid: 'xyz' }]) assert.equal(call('unity_refs', bad).isError, true, JSON.stringify(bad))
  const scoped = ok('unity_refs', { guid: G.enemy, usages: true }, context(['Assets/Prefabs', 'Assets/Data']))
  assert.match(scoped, /usos: 1 arquivo/); assert.match(scoped, /escopo restrito/); assert.doesNotMatch(scoped, /Main\.unity/)
  // índice percebe arquivos novos após o TTL de cache
  put('Assets/Data/Other.asset', `${Y}--- !u!114 &1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ${G.config}, type: 3}\n  e: {fileID: 1, guid: ${G.enemy}, type: 3}\n`)
  try {
    const at = Date.now; Date.now = () => at() + 60_000
    try { assert.match(ok('unity_refs', { guid: G.enemy, usages: true }, ctx, 20000), /usos: 3 arquivo/) } finally { Date.now = at }
  } finally { fs.rmSync(path.join(cwd, 'Assets/Data/Other.asset')) }
})

test('segurança: internos, credenciais, traversal, links e escopo', () => {
  for (const p of ['Library/PackageCache/com.foo@1.0/uses.asset', 'Temp/x.log', 'UserSettings/Layouts.dwlt', '.git/config', 'Assets/Plugins/Android/release.keystore', '../outside/x.unity', path.join(cwd, 'Assets/Scenes/Main.unity'), 'Logs/AssetImportWorker0.log']) {
    const r = call('unity_asset', { path: p }); assert.equal(r.isError, true, p); assert.doesNotMatch(r.text, /KEYSTORE_SECRET/)
    assert.equal(call('unity_diagnostics', { path: p, raw: true }).isError, true, p)
  }
  assert.equal(call('unity_refs', { path: 'Assets/Plugins/Android/release.keystore' }).isError, true)
  fs.writeFileSync(path.join(outside, 'private.unity'), `${Y}--- !u!1 &1\nGameObject:\n  m_Name: SECRET\n`)
  fs.symlinkSync(outside, path.join(cwd, 'Assets', 'linked'), 'dir')
  try {
    const r = call('unity_asset', { path: 'Assets/linked/private.unity' }); assert.equal(r.isError, true); assert.doesNotMatch(r.text, /SECRET/)
    assert.doesNotMatch(ok('unity_refs', { guid: G.enemy, usages: true }, ctx, 20000), /private/)
  } finally { fs.rmSync(path.join(cwd, 'Assets', 'linked')) }
  const scoped = context(['Assets/Scenes'])
  const t = ok('unity_asset', { path: 'Assets/Scenes/Main.unity' }, scoped)
  assert.match(t, /\[fora do escopo\]/); assert.doesNotMatch(t, /Enemy\.prefab|PlayerController\.cs/)
  assert.equal(call('unity_asset', { path: 'Assets/Prefabs/Enemy.prefab' }, scoped).isError, true)
  assert.equal(call('unity_project', {}, scoped).isError, true)
  assert.match(call('unity_asset', { path: 'Assets/Art/Binary.asset' }).text, /Force Text/)
  assert.match(call('unity_asset', { path: 'Assets/Scripts/PlayerController.cs' }).text, /Não é YAML Unity/)
})

const editorLog = `Unity Editor version:    2022.3.20f1 (61c2feb0970d)
COMMAND LINE ARGUMENTS:
/opt/unity/Editor/Unity
-projectPath
/home/dev/secret-client/OrbitRunner

[Licensing::Module] Error: Access token is unavailable; failed to update
${Array.from({ length: 3 }, () => `Assets/Scripts/PlayerController.cs(12,17): error CS0103: The name 'jumpForce' does not exist in the current context
Assets/Scripts/Spawner.cs(4,20): warning CS0414: The field 'Spawner.count' is assigned but its value is never used
`).join('\n')}
Scripts have compiler errors.

NullReferenceException: Object reference not set to an instance of an object
  at PlayerController.Update () [0x00012] in /home/dev/secret-client/OrbitRunner/Assets/Scripts/PlayerController.cs:31
  at UnityEngine.Internal.Something () [0x0] in <filename unknown>:0

(Filename: /home/dev/secret-client/OrbitRunner/Assets/Scripts/PlayerController.cs Line: 31)

Spawn failed: no prefab
UnityEngine.Debug:LogError (object)
Spawner:Start () (at Assets/Scripts/Spawner.cs:9)

Low ammo
UnityEngine.Debug:LogWarning (object)
Weapon:Fire () (at Assets/Scripts/Weapon.cs:22)

An error occurred while resolving packages:
  Project has invalid dependencies:
    com.acme.missing: Package [com.acme.missing@1.0.0] cannot be found

Shader error in 'Custom/Water': undeclared identifier 'foo' at line 42 (on d3d11)

Build Finished, Result: Failed.
Aborting batchmode due to failure:
Fatal Error! Build failed
`

test('diagnostics: log agrupa compilação, exceções, logs, pacotes, shader, build e licença; caminhos externos ocultos', () => {
  put('Builds/Editor.log', editorLog)
  const t = ok('unity_diagnostics', { path: 'Builds/Editor.log' }, ctx, 20000)
  assert.match(t, /\[erro compilação CS0103\] Assets\/Scripts\/PlayerController\.cs:12:17 The name 'jumpForce'.* ×3/)
  assert.match(t, /\[aviso compilação CS0414\] Assets\/Scripts\/Spawner\.cs:4:20 .* ×3/)
  assert.match(t, /\[erro exceção NullReferenceException\] Assets\/Scripts\/PlayerController\.cs:31 Object reference not set/)
  assert.match(t, /\[erro LogError\] Assets\/Scripts\/Spawner\.cs:9 Spawn failed: no prefab/)
  assert.match(t, /\[aviso LogWarning\] Assets\/Scripts\/Weapon\.cs:22 Low ammo/)
  assert.match(t, /\[erro pacotes\] .*com\.acme\.missing/); assert.match(t, /\[erro shader Custom\/Water\]/)
  assert.match(t, /\[erro build\] Build Finished, Result: Failed/); assert.match(t, /\[erro batchmode\] Aborting batchmode due to failure: Fatal Error! Build failed/)
  assert.match(t, /\[erro licença\]/); assert.match(t, /não prova sucesso/)
  assert.doesNotMatch(t, /secret-client|\/home\/dev/)
  const i = t.split('\n').find(l => /^\d+ \[erro exceção/.test(l))!.split(' ')[0]
  const d = ok('unity_diagnostics', { path: 'Builds/Editor.log', detail: Number(i) })
  assert.match(d, /frame do projeto: at PlayerController\.Update \(\) \[0x00012\] in Assets\/Scripts\/PlayerController\.cs:31/); assert.match(d, /pilha:\n/); assert.doesNotMatch(d, /secret-client/)
  const raw = ok('unity_diagnostics', { path: 'Builds/Editor.log', raw: true }, ctx, 800)
  assert.ok(next(raw)); assert.doesNotMatch(raw, /secret-client/); assert.match(raw, /\[caminho fora do escopo\]/)
  assert.match(ok('unity_diagnostics', { path: 'Builds/Editor.log', raw: true }, ctx, 20000), /\(Filename: Assets\/Scripts\/PlayerController\.cs Line: 31\)/)
  assert.equal(call('unity_diagnostics', { path: 'Builds/Editor.log', raw: true, detail: 0 }).isError, true)
  assert.equal(call('unity_diagnostics', { path: 'Builds/Editor.log', detail: 99 }).isError, true)
  assert.equal(call('unity_diagnostics', { path: 'Assets/Scenes/Main.unity' }).isError, true)
})

test('diagnostics: NUnit XML com totais, falhas, erro de setup e pulados', () => {
  put('Builds/results.xml', `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="4" result="Failed(Child)" total="4" passed="1" failed="2" inconclusive="0" skipped="1" asserts="0" engine-version="3.5.0.0" start-time="2026-09-30 10:00:00Z" end-time="2026-09-30 10:00:01Z" duration="1.2345">
  <test-suite type="TestSuite" id="1000" name="OrbitRunner" fullname="OrbitRunner" result="Failed" site="Child">
    <test-suite type="Assembly" id="1001" name="Game.Tests.dll" fullname="/home/dev/secret-client/Library/ScriptAssemblies/Game.Tests.dll" result="Failed" site="Child">
      <test-suite type="TestFixture" id="1002" name="PlayerTests" fullname="Game.Tests.PlayerTests" result="Failed" site="Child">
        <test-case id="1003" name="Jump_IncreasesY" fullname="Game.Tests.PlayerTests.Jump_IncreasesY" result="Failed" duration="0.012">
          <failure>
            <message><![CDATA[  Expected: 1.0f
  But was:  0.0f
]]></message>
            <stack-trace><![CDATA[at Game.Tests.PlayerTests.Jump_IncreasesY () [0x00010] in /home/dev/secret-client/Assets/Tests/PlayerTests.cs:15
]]></stack-trace>
          </failure>
          <output><![CDATA[jump log]]></output>
        </test-case>
        <test-case id="1004" name="Move" fullname="Game.Tests.PlayerTests.Move" result="Passed" duration="0.001" />
        <test-case id="1005" name="Later" fullname="Game.Tests.PlayerTests.Later" result="Skipped" label="Ignored"><reason><message>not ready &amp; flaky</message></reason></test-case>
      </test-suite>
      <test-suite type="TestFixture" id="1006" name="SaveTests" fullname="Game.Tests.SaveTests" result="Failed" label="Error" site="SetUp">
        <failure><message><![CDATA[System.IO.IOException : disk full]]></message><stack-trace><![CDATA[at Game.Tests.SaveTests.Setup () in C:\\ci\\proj\\Assets\\Tests\\SaveTests.cs:8]]></stack-trace></failure>
        <test-case id="1007" name="Save" fullname="Game.Tests.SaveTests.Save" result="Failed" label="Error" site="Parent"><failure><message><![CDATA[OneTimeSetUp: System.IO.IOException : disk full]]></message></failure></test-case>
      </test-suite>
    </test-suite>
  </test-suite>
</test-run>
`)
  const t = ok('unity_diagnostics', { path: 'Builds/results.xml' })
  assert.match(t, /NUnit: Failed\(Child\) · 4 teste\(s\), 1 passaram, 2 falharam, 1 pulados, 0 inconclusivos · 1\.23 s/)
  assert.match(t, /\[erro teste falhou Game\.Tests\.PlayerTests\.Jump_IncreasesY\] Assets\/Tests\/PlayerTests\.cs:15 Expected: 1\.0f ⏎ But was: {2}0\.0f/)
  assert.match(t, /\[erro suite SetUp Game\.Tests\.SaveTests\] Assets\/Tests\/SaveTests\.cs:8 System\.IO\.IOException : disk full/)
  assert.match(t, /\[erro teste com exceção Game\.Tests\.SaveTests\.Save\] OneTimeSetUp/)
  assert.match(t, /\[aviso pulado Game\.Tests\.PlayerTests\.Later\] not ready & flaky/)
  assert.doesNotMatch(t, /secret-client/)
  assert.match(ok('unity_diagnostics', { path: 'Builds/results.xml', detail: 0 }), /--- output ---\njog|--- output ---\njump log/)
  put('Builds/empty.xml', '<test-run total="0" passed="0" failed="0" result="Passed"></test-run>')
  assert.match(ok('unity_diagnostics', { path: 'Builds/empty.xml' }), /nenhum teste executado/)
  put('Builds/other.xml', '<root/>')
  assert.match(call('unity_diagnostics', { path: 'Builds/other.xml' }).text, /não é resultado NUnit/)
})

// Consultas locais Unity: YAML textual, GUIDs/.meta e logs locais. Sem executar a engine, sem Library/Temp/Logs, sem histórico de agentes.
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { sha } from './artifacts.ts'
import { bool, checkArgs, engineContext, fail, hideAbsolute, localPath, num, page, pageArgs, schema, source, str, type Local, type Source } from './engineTools.ts'
import type { ContextLimits } from './limits.ts'
import type { ToolDef, ToolResult } from './mcp.ts'
import type { ToolCtx } from './taskContext.ts'
import { BUILTIN_GUIDS, CREDENTIAL, KNOWN_SCRIPTS, docText, fieldText, nodePath, logPaths, parseUnityYaml, rawAt, refOf, refs, unityIndex, unityLog, unityProject, unityTestResults, unityTree, valueOf, type UnityDiag, type UnityDoc, type UnityNode, type UnityTree, type UnityYaml } from './unity.ts'

export const UNITY_TOOLS: ToolDef[] = [
  { name: 'unity_project', description: 'Resumo Unity: editor, pacotes, render pipeline, input, cenas do build, asmdefs, tags/layers. Não executa a engine.', inputSchema: schema(pageArgs) },
  { name: 'unity_asset', description: 'YAML Unity (.unity/.prefab/.asset/.mat/.controller) sem ler tudo. Padrão: hierarquia (controller: estados/transições). object=Caminho|&id: componentes e overrides; component=Tipo|&id + property=a.b: YAML bruto; find: nomes/tipos.', inputSchema: schema({ path: { type: 'string' }, object: { type: 'string' }, component: { type: 'string' }, property: { type: 'string' }, find: { type: 'string' }, ...pageArgs }, ['path']) },
  { name: 'unity_refs', description: 'GUID via .meta: path→guid e dependências, ou guid→path. usages=true: quem cita (objeto/campo) e o nome em strings C#. Use antes de mover/apagar.', inputSchema: schema({ path: { type: 'string' }, guid: { type: 'string' }, usages: { type: 'boolean' }, ...pageArgs }) },
  { name: 'unity_diagnostics', description: 'Erros/avisos agrupados de Editor.log/-logFile ou NUnit XML (-testResults). detail=índice: pilha; raw=true: fonte paginada.', inputSchema: schema({ path: { type: 'string' }, detail: { type: 'integer', minimum: 0 }, raw: { type: 'boolean' }, ...pageArgs }, ['path']) }
]
const INTERNAL = ['.git', '.worktrees', 'Library', 'Temp', 'Logs', 'UserSettings', 'obj']
const BORING = new Set(['m_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'm_PrefabParentObject', 'm_PrefabInternal', 'm_GameObject', 'm_Enabled', 'm_EditorHideFlags', 'm_Script', 'm_EditorClassIdentifier', 'serializedVersion'])
const text = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
const clip = (s: string, n = 160) => { const t = s.replace(/\s*\n\s*/g, ' ⏎ '); return t.length > n ? t.slice(0, n - 1) + '…' : t }

// Cenas reais passam de 4 MiB; parse+hierarquia de 14 MiB mede ~0,5 s e fica em cache por hash. Demais leituras seguem MAX_SOURCE.
const MAX_ASSET = 16 * 1024 * 1024
function load(c: Local, p: unknown, binaryHint?: string, max?: number): Source {
  if (str(p, 'path').split(/[\\/]/).some(s => CREDENTIAL.test(s))) fail('Arquivo interno/credencial fora destas consultas.')
  try { return source(c, p, max) } catch (e: any) { if (binaryHint && /binário/.test(e?.message)) fail(binaryHint); throw e }
}
const visible = (c: Local, rel: string) => c.allow(rel) && !rel.split('/').some(s => c.internal.includes(s) || CREDENTIAL.test(s))
const restricted = (c: Local) => !c.allow('\0')

// Cache de YAML por caminho + hash do conteúdo (a leitura limitada já calcula o hash).
const yamlCache = new Map<string, { hash: string; y: UnityYaml }>()
function yamlOf(file: Source): UnityYaml {
  const hit = yamlCache.get(file.abs)
  if (hit?.hash === file.hash) return hit.y
  const y = parseUnityYaml(file.text)
  yamlCache.delete(file.abs); yamlCache.set(file.abs, { hash: file.hash, y })
  if (yamlCache.size > 24) yamlCache.delete(yamlCache.keys().next().value as string)
  return y
}
// Hierarquia com o GameObject raiz de cada prefab de origem legível (nome/atividade exatos da instância).
// Cache por YAML (já chaveado por hash) + raízes das origens: cenas grandes não refazem a árvore a cada consulta.
const trees = new WeakMap<UnityYaml, { sig: string; tree: UnityTree }>(), rootIds = new Map<string, string | undefined>() // raiz por prefab (tamanho+mtime): cenas com centenas de origens não relêem cada uma
function treeOf(c: Local, g: G, y: UnityYaml): UnityTree {
  const memo = new Map<string, string | undefined>()
  const root = (guid: string) => {
    if (memo.has(guid)) return memo.get(guid)
    let id: string | undefined
    const p = g.idx.byGuid.get(guid), rec = p ? g.idx.files.get(p) : undefined, k = rec ? `${c.cwd}\0${p}\0${rec.size}:${rec.mtimeMs}` : ''
    if (!p?.endsWith('.prefab') || !visible(c, p)) id = undefined
    else if (k && rootIds.has(k)) id = rootIds.get(k)
    else {
      try { const roots = unityTree(yamlOf(load(c, p, undefined, MAX_ASSET))).roots; id = roots.length === 1 && roots[0].kind === 'go' ? roots[0].id : undefined } catch { /* origem ilegível */ }
      if (k) { rootIds.set(k, id); if (rootIds.size > 5000) rootIds.delete(rootIds.keys().next().value as string) }
    }
    memo.set(guid, id)
    return id
  }
  const sources = new Set(y.docs.filter(d => d.classId === 1001).map(d => (refOf(y, d, 'm_SourcePrefab') ?? refOf(y, d, 'm_ParentPrefab'))?.guid).filter(Boolean) as string[])
  const sig = [...sources].map(s => `${s}:${root(s) ?? ''}`).join(','), hit = trees.get(y)
  if (hit?.sig === sig) return hit.tree
  const tree = unityTree(y, root)
  trees.set(y, { sig, tree })
  return tree
}
// Objeto alvo de um override na prefab de origem: segue stripped/variantes (fileID interno = (instância ^ origem) & 0x7FFF…) até 4 níveis.
function targetOf(c: Local, g: G, guid: string | undefined, id: string, depth = 0): string | undefined {
  const key = `${guid}:${id}`
  if (g.targets.has(key)) return g.targets.get(key)
  const hit = targetIn(c, g, guid, id, depth)
  g.targets.set(key, hit)
  return hit
}
function targetIn(c: Local, g: G, guid: string | undefined, id: string, depth: number): string | undefined {
  const p = guid ? g.idx.byGuid.get(guid) : undefined
  if (!p?.endsWith('.prefab') || !visible(c, p) || depth > 3 || !/^-?\d+$/.test(id)) return
  try {
    const y = yamlOf(load(c, p, undefined, MAX_ASSET)), d = y.byId.get(id)
    if (d?.stripped) { const r = refOf(y, d, 'm_CorrespondingSourceObject'); return r?.guid ? targetOf(c, g, r.guid, r.fileID, depth + 1) : undefined }
    if (d) { const n = treeOf(c, g, y).owner.get(d.id); return `${n ? nodePath(n) : '?'}${d.type === 'GameObject' ? '' : ' · ' + g.comp(y, d)}` }
    for (const pi of y.docs.filter(x => x.classId === 1001)) {
      const src = refOf(y, pi, 'm_SourcePrefab') ?? refOf(y, pi, 'm_ParentPrefab'), inner = (BigInt(id) ^ BigInt(pi.id)) & 0x7FFFFFFFFFFFFFFFn
      const hit = src?.guid ? targetOf(c, g, src.guid, inner.toString(), depth + 1) : undefined
      if (hit) return hit
    }
  } catch { /* origem ilegível */ }
}

// Resolução de GUID: caminho visível, built-in, pacote conhecido ou "não resolvido" explícito.
function guids(c: Local) {
  const idx = unityIndex(c.cwd, INTERNAL)
  const label = (g: string): string => {
    const p = idx.byGuid.get(g)
    if (p) return visible(c, p) ? p : '[fora do escopo]'
    return BUILTIN_GUIDS[g] ? `[${BUILTIN_GUIDS[g]}]` : KNOWN_SCRIPTS[g] ? `[pacote: ${KNOWN_SCRIPTS[g]}]` : '[não resolvido: pacote em Library/PackageCache, removido ou sem .meta]'
  }
  const scripts = new Map<string, string>(), unresolved = new Set<string>()
  const script = (y: UnityYaml, d: UnityDoc): string => {
    const r = refOf(y, d, 'm_Script')
    if (!r?.guid || r.fileID === '0') return 'MonoBehaviour(script ausente)'
    const p = idx.byGuid.get(r.guid), ecid = text(valueOf(y, d, 'm_EditorClassIdentifier')).split(/::|\./).pop()
    if (p && visible(c, p)) { const name = p.endsWith('.cs') ? path.posix.basename(p, '.cs') : ecid || `${path.posix.basename(p)}#${r.fileID}`; scripts.set(name, p); return name }
    if (KNOWN_SCRIPTS[r.guid]) return KNOWN_SCRIPTS[r.guid]
    if (ecid) return `${ecid}(pacote?)`
    unresolved.add(r.guid)
    return `MonoBehaviour?${r.guid.slice(0, 8)}`
  }
  const comp = (y: UnityYaml, d: UnityDoc) => (d.type === 'MonoBehaviour' ? script(y, d) : d.type || `classe ${d.classId}`) + (text(valueOf(y, d, 'm_Enabled')) === '0' ? '(desativado)' : '')
  const legend = (shown: string) => [
    ...[...scripts].filter(([n]) => shown.includes(n)).length ? [`scripts: ${[...scripts].filter(([n]) => shown.includes(n)).map(([n, p]) => `${n}=${p}`).join('; ')}`] : [],
    ...[...unresolved].filter(g => shown.includes(g.slice(0, 8))).map(g => `MonoBehaviour?${g.slice(0, 8)} = guid ${g} ${label(g)}`)
  ]
  // LayerMask (m_Bits) em nomes do TagManager: 0 = Nothing é causa comum de raycast/ground check que nunca acerta.
  let names: string[] | undefined
  const mask = (bits: string) => {
    const n = Number(bits) >>> 0
    if (n === 0) return 'Nothing'
    if (n === 0xFFFFFFFF) return 'Everything'
    if (!names) { names = []; try { const t = yamlOf(load(c, 'ProjectSettings/TagManager.asset')), d = t.docs[0], v = d && valueOf(t, d, 'layers'); if (Array.isArray(v)) names = v.map(text) } catch { /* sem TagManager */ } }
    const on: string[] = []
    for (let k = 0; k < 32; k++) if (n & (1 << k)) on.push(names[k] || `#${k}`)
    return on.join(', ')
  }
  return { idx, label, comp, legend, mask, targets: new Map<string, string | undefined>() }
}
type G = ReturnType<typeof guids>

// Legenda de referências de um trecho bruto: GUIDs viram caminhos e fileIDs locais viram objetos do arquivo.
function refLegend(g: G, y: UnityYaml, tree: UnityTree, raw: string) {
  const out: string[] = [], seen = new Set<string>()
  for (const r of refs(raw)) {
    const key = r.guid ? `${r.guid}` : r.fileID
    if (seen.has(key) || r.fileID === '0' && !r.guid || seen.size >= 30) continue
    seen.add(key)
    if (r.guid) out.push(`guid ${r.guid} → ${g.label(r.guid)}`)
    else { const d = y.byId.get(r.fileID), n = tree.owner.get(r.fileID); out.push(`&${r.fileID} → ${d ? `${n ? nodePath(n) + ' · ' : ''}${d.type === 'GameObject' ? 'GameObject' : g.comp(y, d)}` : 'não está neste arquivo'}`) }
  }
  const masks = [...new Set([...raw.matchAll(/m_Bits: (\d+)/g)].map(m => m[1]))].slice(0, 8).map(b => `m_Bits ${b} = ${g.mask(b)}`)
  return (out.length ? `\nreferências:\n${out.join('\n')}` : '') + (masks.length ? `\nlayers: ${masks.join('; ')}` : '')
}

const vec = (v: unknown, def: string) => { if (!v || typeof v !== 'object') return ''; const s = Object.values(v as object).map(text).join(', '); return s === def ? '' : `(${s})` }
function nodeLine(g: G, y: UnityYaml, n: UnityNode) {
  const comps = n.comps.map(d => g.comp(y, d)), counted: string[] = []
  for (const l of new Set(comps)) { const k = comps.filter(x => x === l).length; counted.push(k > 1 ? `${l}×${k}` : l) }
  if (n.transform?.type === 'RectTransform') counted.unshift('RectTransform')
  const list = counted.length ? ` [${n.kind === 'prefab' ? '+' : ''}${counted.join(', ')}]` : ''
  if (n.kind === 'go') return `${n.name} &${n.id}${n.active ? '' : ' (inativo)'}${list}`
  return `${n.name || '?'} &${n.id} ⇒ prefab ${n.source?.guid ? g.label(n.source.guid) : '[origem ausente]'} · ${n.mods} mod(s)${n.active ? '' : ' (inativo)'}${list}`
}
const sizes = new WeakMap<UnityNode, number>()
const size = (n: UnityNode): number => { let k = sizes.get(n); if (k === undefined) sizes.set(n, k = n.children.reduce((a, c) => a + 1 + size(c), 0)); return k }
function renderTree(g: G, y: UnityYaml, roots: UnityNode[], depth: number, memo: Map<UnityNode, string>, budget: number, kids = 40) {
  const out: string[] = [], line = (n: UnityNode) => { let l = memo.get(n); if (l === undefined) memo.set(n, l = nodeLine(g, y, n)); return l }
  const rec = (n: UnityNode, d: number) => {
    const below = size(n)
    if (d >= depth && below) { out.push(`${'  '.repeat(d)}${line(n)} (+${below} abaixo)`); return }
    out.push('  '.repeat(d) + line(n))
    n.children.slice(0, kids).forEach(k => rec(k, d + 1))
    if (n.children.length > kids) out.push(`${'  '.repeat(d + 1)}… +${n.children.length - kids} filhos; object=&${n.id}`)
  }
  let used = 0, shown = 0
  for (const n of roots) {
    const mark = out.length
    rec(n, 0)
    const add = out.slice(mark).reduce((a, l) => a + l.length + 1, 0)
    if (depth === 0 && shown && used + add > budget) { out.length = mark; break }
    used += add; shown++
  }
  if (shown < roots.length) out.push(`… +${roots.length - shown} raízes; use find= ou object=`)
  return out.join('\n')
}

function pickNode(tree: UnityTree, sel: string): UnityNode {
  const id = /^&?(-?\d+)$/.exec(sel)?.[1]
  if (id) return tree.owner.get(id) ?? fail('fileID não é GameObject/prefab/componente de objeto deste arquivo; use component=&id.')
  const hits = tree.nodes.filter(n => nodePath(n) === sel)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) fail(`Caminho ambíguo (${hits.length} objetos): ${hits.slice(0, 12).map(n => '&' + n.id).join(', ')}; use object=&fileID.`)
  const near = tree.nodes.filter(n => n.name === sel.split('/').pop())
  return fail(near.length ? `Caminho não encontrado; candidatos: ${near.slice(0, 8).map(n => `${nodePath(n)} &${n.id}`).join('; ')}` : 'Objeto não encontrado; use find=.')
}
function fieldNames(d: UnityDoc, max = 40) {
  const names = d.fields.map(f => f.key).filter(k => !BORING.has(k) && !(d.type === 'MonoBehaviour' && k === 'm_Name'))
  return names.length ? names.slice(0, max).join(', ') + (names.length > max ? ` +${names.length - max}` : '') : '(sem campos próprios)'
}
function objectBody(c: Local, g: G, y: UnityYaml, tree: UnityTree, n: UnityNode) {
  const out: string[] = []
  const rec = (n: UnityNode, d: number) => {
    const pad = '  '.repeat(d)
    if (n.kind === 'go') {
      out.push(`${pad}${nodePath(n)} &${n.id} · GameObject${n.active ? '' : ' (inativo)'} · tag ${text(valueOf(y, n.doc, 'm_TagString')) || '?'} · layer ${text(valueOf(y, n.doc, 'm_Layer')) || '?'} · linhas ${n.doc.line}-${n.doc.end}`)
      if (n.transform) {
        const t = n.transform, pos = vec(valueOf(y, t, 'm_LocalPosition'), '0, 0, 0'), rot = vec(valueOf(y, t, 'm_LocalEulerAnglesHint'), '0, 0, 0'), sc = vec(valueOf(y, t, 'm_LocalScale'), '1, 1, 1')
        out.push(`${pad}  ${t.type} &${t.id}${pos ? ' pos' + pos : ''}${rot ? ' rot' + rot : ''}${sc ? ' escala' + sc : ''}${t.type === 'RectTransform' ? ' · ' + fieldNames(t, 12) : ''}`)
      }
    } else {
      const m = valueOf(y, n.doc, 'm_Modification') as any, mods: any[] = Array.isArray(m?.m_Modifications) ? m.m_Modifications : []
      out.push(`${pad}${nodePath(n)} &${n.id} · PrefabInstance ⇒ ${n.source?.guid ? g.label(n.source.guid) : '[origem ausente]'} · linhas ${n.doc.line}-${n.doc.end} · overrides (${mods.length}) por alvo na origem:`)
      // Overrides agrupados pelo objeto alvo na origem; eixos (m_LocalPosition.x/.y/.z) viram uma entrada.
      const groups = new Map<string, { guid?: string; props: Map<string, [string, string][]> }>()
      for (const x of mods.slice(0, 80)) {
        const t = text(x?.target?.fileID), r = x?.objectReference, v = text(x?.value), pp = text(x?.propertyPath), ax = /^(.+)\.([xyzwrgba])$/.exec(pp)
        const own = r?.fileID && !r.guid ? tree.owner.get(r.fileID) : undefined
        const val = r?.fileID && r.fileID !== '0' ? '→ ' + (r.guid ? g.label(r.guid) : `${own ? nodePath(own) + ' ' : ''}&${r.fileID}`) : v === '' ? '""' : /(?:^|\.)m_Bits$/.test(pp) && /^\d+$/.test(v) ? `${v} (${g.mask(v)})` : clip(v, 60)
        const grp = groups.get(t) ?? groups.set(t, { guid: x?.target?.guid, props: new Map() }).get(t)!, key = ax ? ax[1] + '\0' : pp
        grp.props.set(key, [...grp.props.get(key) ?? [], [ax ? ax[2] : '', val]])
      }
      for (const [t, { guid, props }] of groups) out.push(`${pad}  ${targetOf(c, g, guid, t) ?? '&' + t}: ${[...props].map(([k, v]) => k.endsWith('\0') ? `${k.slice(0, -1)}.${v.map(a => a[0]).join('')}=${v.length > 1 ? `(${v.map(a => a[1]).join(', ')})` : v[0][1]}` : `${k}=${v.map(a => a[1]).join(', ')}`).join('; ')}`)
      if (mods.length > 80) out.push(`${pad}  … +${mods.length - 80} overrides; component=&${n.id} property=m_Modification.m_Modifications`)
      for (const k of ['m_RemovedComponents', 'm_RemovedGameObjects', 'm_AddedGameObjects', 'm_AddedComponents']) { const v = m?.[k]; if (Array.isArray(v) && v.length) out.push(`${pad}  ${k}: ${v.length}`) }
    }
    for (const c of n.comps) out.push(`${pad}  ${g.comp(y, c)} &${c.id} · ${fieldNames(c)}`)
    n.children.forEach(k => rec(k, d + 1))
  }
  rec(n, 0)
  return out.join('\n')
}

// AnimatorController: parâmetros, camadas, estados e transições com condições legíveis (o YAML liga tudo por fileID).
const PARAM: Record<string, string> = { '1': 'Float', '3': 'Int', '4': 'Bool', '9': 'Trigger' }
const COND: Record<string, (p: string, t: string) => string> = { '1': p => p, '2': p => '!' + p, '3': (p, t) => `${p} > ${t}`, '4': (p, t) => `${p} < ${t}`, '6': (p, t) => `${p} == ${t}`, '7': (p, t) => `${p} != ${t}` }
function animatorBody(g: G, y: UnityYaml, ctrl: UnityDoc) {
  const list = (d: UnityDoc | undefined, k: string) => { const v = d && valueOf(y, d, k); return Array.isArray(v) ? v as any[] : [] }
  const doc = (r: any) => r?.fileID && r.fileID !== '0' ? y.byId.get(String(r.fileID)) : undefined
  const name = (d: UnityDoc | undefined) => d ? text(valueOf(y, d, 'm_Name')) || `&${d.id}` : '?'
  const params = new Map(list(ctrl, 'm_AnimatorParameters').map(p => [text(p?.m_Name), PARAM[text(p?.m_Type)] ?? `tipo ${text(p?.m_Type)}`]))
  const missing = new Set<string>(), out = [`AnimatorController "${name(ctrl)}" &${ctrl.id} · parâmetros: ${[...params].map(([n, t]) => `${n}:${t}`).join(', ') || 'nenhum'}`]
  const motion = (d: UnityDoc) => { const r = refOf(y, d, 'm_Motion'); if (!r || r.fileID === '0') return 'sem motion'; if (r.guid) return path.posix.basename(g.label(r.guid)); const m = y.byId.get(r.fileID); return m ? `${m.type} "${name(m)}"` : `&${r.fileID}` }
  const trans = (r: any) => {
    const t = doc(r)
    if (!t) return `&${text(r?.fileID)}?`
    const conds = list(t, 'm_Conditions').map(c => { const p = text(c?.m_ConditionEvent), f = COND[text(c?.m_ConditionMode)]; if (!params.has(p)) missing.add(p); return (f ? f(p, text(c?.m_EventTreshold)) : `${p} modo ${text(c?.m_ConditionMode)}`) + (params.has(p) ? '' : ' ⚠') })
    if (text(valueOf(y, t, 'm_HasExitTime')) === '1') conds.push(`exit ${text(valueOf(y, t, 'm_ExitTime'))}`)
    const dst = text(valueOf(y, t, 'm_IsExit')) === '1' ? 'Exit' : doc(refOf(y, t, 'm_DstState')) ? name(doc(refOf(y, t, 'm_DstState'))) : doc(refOf(y, t, 'm_DstStateMachine')) ? `⟨${name(doc(refOf(y, t, 'm_DstStateMachine')))}⟩` : '?'
    return `→ ${dst} [${conds.join(', ') || 'sem condição'}]${text(valueOf(y, t, 'm_Mute')) === '1' ? ' (mudo)' : ''} &${t.id}`
  }
  const behaviours = (d: UnityDoc) => { const b = refs(fieldText(y, d.fields.find(f => f.key === 'm_StateMachineBehaviours') ?? { line: 0, end: -1 })).map(r => y.byId.get(r.fileID)).filter(Boolean) as UnityDoc[]; return b.length ? ` · behaviours: ${b.map(x => g.comp(y, x)).join(', ')}` : '' }
  const seen = new Set<string>()
  const machine = (sm: UnityDoc | undefined, pad: string) => {
    if (!sm || seen.has(sm.id)) return
    seen.add(sm.id)
    const def = doc(refOf(y, sm, 'm_DefaultState'))
    out.push(`${pad}máquina "${name(sm)}" &${sm.id} · padrão ${def ? name(def) : '-'}${behaviours(sm)}`)
    const any = list(sm, 'm_AnyStateTransitions'), entry = list(sm, 'm_EntryTransitions')
    if (any.length) out.push(`${pad}  Any State ${any.map(trans).join('; ')}`)
    if (entry.length) out.push(`${pad}  Entry ${entry.map(trans).join('; ')}`)
    for (const c of list(sm, 'm_ChildStates')) {
      const st = doc(c?.m_State)
      if (!st) { out.push(`${pad}  &${text(c?.m_State?.fileID)} (estado ausente)`); continue }
      const tr = list(st, 'm_Transitions')
      out.push(`${pad}  ${name(st)} &${st.id} (${motion(st)}${text(valueOf(y, st, 'm_Speed')) && text(valueOf(y, st, 'm_Speed')) !== '1' ? ` ×${text(valueOf(y, st, 'm_Speed'))}` : ''})${behaviours(st)}${tr.length ? ' ' + tr.map(trans).join('; ') : ''}`)
    }
    for (const c of list(sm, 'm_ChildStateMachines')) machine(doc(c?.m_StateMachine), pad + '  ')
  }
  for (const l of list(ctrl, 'm_AnimatorLayers')) {
    out.push(`camada "${text(l?.m_Name)}"${text(l?.m_BlendingMode) === '1' ? ' (aditiva)' : ''}${l?.m_Mask?.guid ? ` · máscara ${g.label(l.m_Mask.guid)}` : ''}`)
    machine(doc(l?.m_StateMachine), '  ')
  }
  if (missing.size) out.push(`⚠ condições usam parâmetro inexistente: ${[...missing].join(', ')}`)
  const kinds = new Map<string, number>()
  for (const d of y.docs) kinds.set(d.type, (kinds.get(d.type) ?? 0) + 1)
  out.push(`docs: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}`)
  return out.join('\n')
}

function assetBody(c: Local, lim: ContextLimits, file: Source, a: Record<string, any>) {
  for (const k of ['object', 'component', 'property', 'find']) if (a[k] !== undefined) str(a[k], k, 500)
  if (a.find !== undefined && (a.object ?? a.component ?? a.property) !== undefined) fail('find não combina com object/component/property.')
  const g = guids(c), y = yamlOf(file), tree = treeOf(c, g, y)
  const scene = tree.nodes.length > 0
  const counts = `${y.docs.length} doc(s), ${tree.nodes.filter(n => n.kind === 'go').length} GameObject(s), ${tree.nodes.filter(n => n.kind === 'prefab').length} prefab(s) instanciada(s), ${tree.stripped} stripped`
  const warn = [...y.warnings, ...tree.warnings].slice(0, 10).map(w => 'aviso: ' + w)
  if (a.find !== undefined) {
    const q = a.find.toLowerCase(), out: string[] = []
    for (const n of tree.nodes) {
      if (n.name.toLowerCase().includes(q)) out.push(`${nodePath(n)} &${n.id} · nome`)
      for (const d of n.comps) { const l = g.comp(y, d); if (l.toLowerCase().includes(q)) out.push(`${nodePath(n)} &${n.id} · ${l} &${d.id}`) }
    }
    for (const d of tree.other) { const l = d.type === 'MonoBehaviour' ? g.comp(y, d) : d.type, nm = text(valueOf(y, d, 'm_Name')); if (`${l} ${nm}`.toLowerCase().includes(q)) out.push(`&${d.id} ${l}${nm ? ` "${nm}"` : ''}`) }
    return `${out.length} ocorrência(s) de "${a.find}" em nomes/tipos. Próximo: object=Caminho ou &fileID.\n${out.join('\n')}${g.legend(out.join('\n')).map(l => '\n' + l).join('')}`
  }
  let docs: UnityDoc[] | undefined, where = ''
  if (a.component !== undefined) {
    const id = /^&?(-?\d+)$/.exec(a.component)?.[1]
    if (id) docs = [y.byId.get(id) ?? fail('fileID não declarado neste arquivo.')]
    else {
      const want = a.component.toLowerCase(), n = a.object !== undefined ? pickNode(tree, a.object) : undefined
      if (!n && scene) fail('component por tipo exige object; ou use component=&fileID.')
      const pool = n ? [n.doc, ...(n.transform ? [n.transform] : []), ...n.comps] : y.docs
      const label = (d: UnityDoc) => (d.type === 'MonoBehaviour' ? g.comp(y, d) : d.type).replace(/\(desativado\)$/, '').toLowerCase()
      docs = pool.filter(d => label(d) === want || d.type.toLowerCase() === want || !n && text(valueOf(y, d, 'm_Name')).toLowerCase() === want)
      if (!docs.length) fail(`Componente não encontrado. Disponíveis: ${pool.slice(0, 20).map(d => `${label(d)} &${d.id}`).join(', ')}`)
      if (docs.length > 1) fail(`Mais de um componente corresponde: ${docs.slice(0, 20).map(d => `${label(d)} &${d.id}`).join(', ')}; use component=&fileID.`)
    }
  } else if (a.object !== undefined) {
    const n = pickNode(tree, a.object)
    if (a.property === undefined) { const body = objectBody(c, g, y, tree, n); return [body, ...g.legend(body), ...warn, 'Próximo: component=Tipo|&id (+ property=campo) para YAML bruto; campos ausentes vêm do default do script/prefab de origem.'].join('\n') }
    docs = [n.doc]
  } else if (a.property !== undefined) {
    if (y.docs.length !== 1) fail(`property exige object ou component: arquivo tem ${y.docs.length} docs.`)
    docs = [y.docs[0]]
  }
  if (docs) {
    const d = docs[0], owner = tree.owner.get(d.id)
    where = `${owner ? nodePath(owner) + ' · ' : ''}${d.type === 'MonoBehaviour' ? g.comp(y, d) : d.type} &${d.id}`
    let span: { line: number; end: number } = { line: d.line, end: d.end }
    if (a.property !== undefined) span = rawAt(y, d, a.property) ?? fail('Campo não declarado neste doc; pode vir do default do script ou da prefab de origem.')
    const raw = a.property !== undefined ? fieldText(y, span) : docText(y, d)
    return `${where}${a.property !== undefined ? ' · ' + a.property : ''} · linhas ${span.line}-${span.end}\n${hideAbsolute(c, raw)}${refLegend(g, y, tree, raw)}`
  }
  if (!scene) {
    const ctrl = y.docs.find(d => d.type === 'AnimatorController')
    if (ctrl) { const body = animatorBody(g, y, ctrl); return [body, ...g.legend(body), ...warn, 'Próximo: component=&id (estado/transição) + property=campo para YAML bruto.'].join('\n') }
    const seen = new Map<string, string>() // campos repetidos por tipo (transições, estados, sub-assets) saem uma vez
    const lines = y.docs.map(d => {
      const nm = text(valueOf(y, d, 'm_Name')), label = d.type === 'MonoBehaviour' ? g.comp(y, d) : d.type, f = fieldNames(d, 25), k = label + '\0' + f, first = seen.get(k)
      if (!first) seen.set(k, d.id)
      return `&${d.id} ${label}${nm ? ` "${nm}"` : ''}${d.stripped ? ' (stripped)' : ''} · ${first ? `campos como &${first}` : f}`
    })
    const body = lines.join('\n')
    return [counts, body, ...g.legend(body), ...warn, 'Próximo: component=&fileID|Tipo + property=campo para valor bruto.'].join('\n')
  }
  const other = tree.other.map(d => d.type).filter(t => t !== 'SceneRoots')
  const target = Math.max(1200, Math.min(lim.queryChars, 8000) - 900)
  const memo = new Map<UnityNode, string>()
  let depth = 12, body = renderTree(g, y, tree.roots, depth, memo, target)
  while (depth > 0 && body.length > target) body = renderTree(g, y, tree.roots, --depth, memo, target)
  return [counts, ...other.length ? [`outros docs: ${[...new Set(other)].join(', ')}`] : [], body, ...g.legend(body),
    ...body.includes(' abaixo)') ? [`profundidade limitada a ${depth}; object=&id expande.`] : [],
    ...tree.nodes.some(n => n.kind === 'prefab') ? ['prefabs instanciadas: conteúdo interno não expandido; abra a origem com unity_asset path=… e veja overrides com object=&id.'] : [],
    ...warn, 'Próximo: object=Caminho|&id (componentes e campos), find=texto, component+property (valor bruto).'].join('\n')
}

function refsBody(c: Local, a: Record<string, any>) {
  if ((a.path === undefined) === (a.guid === undefined)) fail('Informe path ou guid (um dos dois).')
  const usages = bool(a.usages, 'usages')
  let guid: string, asset: string | undefined
  const out: string[] = []
  const g = guids(c)
  if (a.path !== undefined) {
    const f = localPath(c, str(a.path, 'path').replace(/\.meta$/i, ''))
    if (f.rel.split('/').some(s => CREDENTIAL.test(s))) fail('Arquivo interno/credencial fora destas consultas.')
    asset = f.rel
    let meta: Source
    try { meta = source(c, f.rel + '.meta') } catch (e: any) { return `${f.rel}: sem .meta legível (${String(e?.message ?? e).slice(0, 80)}). Asset novo ainda não importado pelo Unity? Não crie nem copie .meta à mão; abra/atualize o editor.` }
    guid = /^guid: ([0-9a-f]{32})\s*$/m.exec(meta.text)?.[1] ?? fail('.meta sem guid reconhecível.')
    out.push(`${f.rel} → guid ${guid}`)
    try {
      const own = source(c, f.rel, MAX_ASSET), counts = new Map<string, number>()
      for (const r of refs(own.text)) if (r.guid && r.guid !== guid) counts.set(r.guid, (counts.get(r.guid) ?? 0) + 1)
      if (counts.size) out.push(`saída: ${counts.size} asset(s) citados por este arquivo`, ...[...counts].slice(0, 60).map(([k, n]) => `  ${k} → ${g.label(k)} ×${n}`), ...counts.size > 60 ? [`  … +${counts.size - 60}`] : [])
    } catch (e: any) { if (!/Não é um arquivo/.test(e?.message)) out.push(`saída: não lida (${String(e?.message ?? e).slice(0, 80)})`) }
  } else {
    guid = str(a.guid, 'guid', 32).toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(guid)) fail('guid deve ter 32 hexadecimais.')
    asset = g.idx.byGuid.get(guid)
    out.push(`guid ${guid} → ${g.label(guid)}`)
  }
  if (!usages) { out.push('Próximo: usages=true lista arquivos que citam este GUID (antes de renomear/apagar).'); return out.join('\n') }
  const idx = unityIndex(c.cwd, INTERNAL, true), hits: [string, number][] = [], skipped = new Map<string, number>()
  for (const [rel, f] of idx.files) {
    if (!visible(c, rel)) continue
    if (f.refs === null) { skipped.set(f.why ?? '?', (skipped.get(f.why ?? '?') ?? 0) + 1); continue }
    const k = f.refs?.get(guid)
    if (k && rel !== asset + '.meta') hits.push([rel, k])
  }
  hits.sort((x, y) => x[0].localeCompare(y[0]))
  out.push(`usos: ${hits.length} arquivo(s), ${hits.reduce((s, h) => s + h[1], 0)} citação(ões)`)
  hits.forEach(([rel, k], i) => {
    let where = ''
    if (i < 40 && /\.(?:unity|prefab|asset|mat|controller|overrideController|anim|playable|mask|physicMaterial|physicsMaterial2D|spriteatlas|lighting|preset|terrainlayer|mixer|signal)$/.test(rel)) {
      try {
        // Campos que citam o GUID primeiro (quebram ao apagar); instâncias de prefab resumidas numa entrada.
        const y = yamlOf(load(c, rel, undefined, MAX_ASSET)), tree = treeOf(c, g, y), fields: string[] = [], inst: string[] = []
        for (const d of y.docs) for (const fl of d.fields) {
          const t = fieldText(y, fl)
          if (!t.includes(guid) || d.stripped && fl.key === 'm_CorrespondingSourceObject') continue
          const n = tree.owner.get(d.id), at = `${n ? nodePath(n) + ' · ' : ''}${d.type === 'MonoBehaviour' ? g.comp(y, d) : d.type}${d.stripped ? ' (stripped)' : ''} &${d.id}`
          if (d.classId === 1001 && (fl.key === 'm_SourcePrefab' || fl.key === 'm_ParentPrefab')) { inst.push(`${n ? nodePath(n) : '?'} &${d.id}`); continue }
          if (fl.key === 'm_Modification') {
            const pp = [...new Set(t.split(/^\s*- target:/m).filter(x => /objectReference: (\{[^}\n]*\})/.exec(x)?.[1].includes(guid)).map(x => /propertyPath: (.*)/.exec(x)?.[1]?.trim() ?? '?'))]
            if (pp.length) fields.push(`${at} override ${pp.slice(0, 3).join('|')}${pp.length > 3 ? ` +${pp.length - 3}` : ''}`)
            continue
          }
          fields.push(`${at}.${fl.key}`)
        }
        const locs = [...fields.slice(0, 6), ...fields.length > 6 ? [`+${fields.length - 6} campo(s)`] : [], ...inst.length ? [`${inst.length} instância(s) de prefab: ${inst.slice(0, 4).join(', ')}${inst.length > 4 ? ` +${inst.length - 4}` : ''}`] : []]
        if (locs.length) where = ' · ' + locs.join('; ')
      } catch { /* só contagem */ }
    } else if (rel.endsWith('.meta')) where = ' · (.meta de outro asset)'
    out.push(`${rel} ×${k}${where}`)
  })
  // Nome do asset em literais C# (Resources.Load("Enemies/Enemy"), endereços Addressables, tags homônimas): possível uso fora do GUID.
  const base = asset && path.posix.basename(asset).replace(/\.[^.]+$/, '')
  if (base && base.length >= 3) {
    const re = new RegExp(`(?:^|/)${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.\\w+)?$`, 'i'), named: string[] = []
    for (const [rel, f] of idx.files) if (f.lits && visible(c, rel)) for (const l of f.lits) if (re.test(l)) named.push(`${rel} "${l}"`)
    if (named.length) out.push(`nome "${base}" em strings C# (${named.length}; Resources/Addressables/tag?): ${named.slice(0, 8).join('; ')}${named.length > 8 ? ` +${named.length - 8}` : ''}`)
  }
  const notes = [...skipped].map(([w, n]) => `${n} ${w}`)
  if (notes.length) out.push(`não varridos: ${notes.join(', ')}`)
  if (idx.truncated) out.push('varredura interrompida no limite de entradas; resultado incompleto.')
  if (idx.links) out.push(`${idx.links} link(s) simbólico(s) não seguidos.`)
  if (idx.hidden.length) out.push(`pastas com nome interno não varridas: ${idx.hidden.slice(0, 5).join(', ')}${idx.hidden.length > 5 ? ` +${idx.hidden.length - 5}` : ''}`)
  if (restricted(c)) out.push('escopo restrito: só arquivos autorizados foram considerados.')
  out.push('Renomear/mover com o .meta preserva o GUID (estes usos seguem válidos); apagar quebra todos. Zero usos não prova segurança: strings montadas em código, Library/PackageCache e binários não são verificados.')
  return out.join('\n')
}

function projectBody(c: Local) {
  const g = guids(c), files = [...g.idx.files.keys()].filter(r => visible(c, r))
  localPath(c, 'ProjectSettings/ProjectVersion.txt')
  const p = unityProject(rel => load(c, rel).text, files)
  // file: é relativo a Packages/; só o que sai do projeto é ocultado.
  const mask = (s: string) => /^file:/i.test(s) ? (/^(?:\/|[a-z]:|\.\.(?:\/|$))/i.test(path.posix.normalize('Packages/' + s.slice(5).replace(/\\/g, '/'))) || /^file:(?:[\\/]|[a-z]:)/i.test(s) ? 'file:[fora do projeto]' : s) : hideAbsolute(c, s.replace(/\/\/[^/@\s]+@/g, '//***@'))
  const ser = p.serialization === 2 ? 'Force Text' : `${p.serialization === 1 ? 'Force Binary' : p.serialization === 0 ? 'Mixed' : 'desconhecida'} ⚠ unity_asset/unity_refs só leem assets em texto`
  const userLayers = p.layers.map((l, i) => l && !['Default', 'TransparentFX', 'Ignore Raycast', 'Water', 'UI'].includes(l) ? `${i}=${l}` : '').filter(Boolean)
  const out = [
    `Unity ${p.editor ?? '?'}${p.revision ? ` (rev ${p.revision})` : ''} · ${p.product ?? '?'} · ${p.company ?? '?'} · versão ${p.version ?? '?'}`,
    `serialização: ${ser} · input: ${p.input ?? '?'}`,
    `render: ${p.pipeline.kind}${p.pipeline.asset?.guid ? ` · asset ${g.label(p.pipeline.asset.guid)}` : ''}`,
    ...Object.keys(p.backends).length ? [`backend: ${Object.entries(p.backends).map(([k, v]) => `${k}=${v}`).join('; ')}`] : [],
    ...Object.keys(p.defines).length ? [`defines: ${Object.entries(p.defines).map(([k, v]) => `${k}=${v}`).join('; ')}`] : [],
    `pacotes (${p.packages.length} + ${p.modules} com.unity.modules.*): ${p.packages.map(x => `${x.name}${x.version ? '@' + mask(x.version) : ''}${x.source === 'registry' ? '' : ` [${x.source}]`}`).join(', ') || 'nenhum'}`,
    `cenas no build (${p.scenes.length}): ${p.scenes.map(s => `${s.enabled ? '✓' : '✗'} ${s.path}`).join('; ') || 'nenhuma'}`,
    `asmdefs (${p.asmdefs.length}): ${p.asmdefs.map(x => `${x.name}${x.test ? ' [teste]' : ''}${x.editor ? ' [Editor]' : ''} (${x.path})`).join('; ') || 'nenhum (Assembly-CSharp)'}`,
    `tags: ${p.tags.join(', ') || '-'} · layers do usuário: ${userLayers.join(', ') || '-'} · sorting: ${p.sortingLayers.join(', ') || '-'}`,
    `arquivos em Assets: ${Object.entries(p.counts).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`,
    ...p.warnings.map(w => 'aviso: ' + mask(w)),
    ...g.idx.truncated ? ['aviso: varredura parou no limite de entradas; contagens/asmdefs parciais.'] : [],
    'Próximo: unity_asset path=<cena> para hierarquia; unity_refs antes de renomear/apagar.'
  ]
  return out.join('\n')
}

function diagBody(c: Local, file: Source, a: Record<string, any>) {
  const raw = bool(a.raw, 'raw')
  if (raw && a.detail !== undefined) fail('Selecione raw ou detail.')
  if (raw) return hideAbsolute(c, logPaths(file.text))
  const xml = /\.xml$/i.test(file.rel)
  let head: string, items: UnityDiag[]
  if (xml) {
    const t = unityTestResults(file.text); items = t.items
    head = `NUnit: ${t.result} · ${t.total} teste(s), ${t.passed} passaram, ${t.failed} falharam, ${t.skipped} pulados, ${t.inconclusive} inconclusivos${t.duration !== null ? ` · ${t.duration.toFixed(2)} s` : ''}${t.total === 0 ? ' · ⚠ nenhum teste executado: filtro, plataforma (EditMode/PlayMode) ou asmdef de teste?' : ''}`
  } else {
    const l = unityLog(file.text); items = l.items
    const by = new Map<string, [number, number]>()
    for (const d of items) if (d.severity !== 'info') { const k = `${d.severity === 'error' ? 'erro' : 'aviso'} ${d.kind}`, v = by.get(k) ?? [0, 0]; by.set(k, [v[0] + 1, v[1] + d.count]) }
    head = `${l.totalLines} linhas · ${[...by].map(([k, [u, n]]) => `${u} ${k}${n > u ? ` (${n} ocorrências)` : ''}`).join(', ') || 'nenhum erro/aviso reconhecido'}`
  }
  const where = (d: UnityDiag) => d.file ? `${/^Library\/PackageCache\//.test(d.file) ? '[pacote] ' + d.file.slice(21) : /^(?:Assets|Packages)\//.test(d.file) ? (visible(c, d.file) ? d.file : '[fora do escopo]') : hideAbsolute(c, d.file)}${d.line ? ':' + d.line : ''}${d.col ? ':' + d.col : ''} ` : ''
  const sev = { error: 'erro', warning: 'aviso', info: 'info' }
  const tag = (d: UnityDiag) => `[${sev[d.severity]} ${d.kind}${d.code ? ' ' + d.code : ''}]`
  if (a.detail !== undefined) {
    const i = num(a.detail, 'detail'), d = items[i] ?? fail('Diagnóstico inexistente.')
    return hideAbsolute(c, `${head}\n#${i} ${tag(d)} ${where(d)}×${d.count} · ${xml ? 'linha XML' : 'linhas do log'} ${d.lines.join(', ')}\n${d.frame ? `frame do projeto: ${d.frame}\n` : ''}mensagem:\n${d.message}${d.stack.length ? `\npilha:\n${d.stack.join('\n')}` : ''}`)
  }
  const list = items.map((d, i) => hideAbsolute(c, `${i} ${tag(d)} ${where(d)}${clip(d.message, 220)}${d.count > 1 ? ` ×${d.count}` : ''} · L${d.lines[0]}`))
  return `${head}${xml ? '' : '\nAusência de diagnóstico reconhecido não prova sucesso (confira o código de saída).'}\n${list.join('\n')}${list.length ? '\nPróximo: detail=<índice> (mensagem e pilha).' : ''}`
}

// Hash curto (64 bits) basta para detectar fonte/consulta alterada entre páginas; 64 hex por resposta custavam ~40 tokens.
const h16 = (s: string) => sha(s).slice(0, 16)
export function callUnityTool(db: DatabaseSync, lim: ContextLimits, ctx: ToolCtx, organizerId: string, name: string, input: unknown): ToolResult {
  try {
    const c = engineContext(db, ctx, 'unity', organizerId, INTERNAL), a = checkArgs(UNITY_TOOLS, name, input)
    if (name === 'unity_project') {
      const body = projectBody(c)
      return { text: page('Unity · projeto', h16(body), body, a, lim, 'Declarado em ProjectSettings/Packages; não verifica editor instalado nem Library.'), isError: false }
    }
    if (name === 'unity_refs') {
      const body = refsBody(c, a)
      return { text: page('Unity · GUID', h16(body), body, a, lim, 'Índice de .meta em Assets/Packages; Library/PackageCache não é lido.'), isError: false }
    }
    if (name === 'unity_asset') {
      const file = load(c, a.path, 'Asset binário: só YAML textual é lido (Force Text; veja unity_project).', MAX_ASSET), body = assetBody(c, lim, file, a)
      return { text: page(`${file.rel} · ${file.lines} linhas`, h16(file.hash + body), body, a, lim, 'Só o declarado no arquivo: defaults de script e interior de prefabs de origem não expandidos.'), isError: false }
    }
    if (name === 'unity_diagnostics') {
      if (!/\.(?:log|txt|xml)$/i.test(str(a.path, 'path'))) fail('path deve ser log .log/.txt ou resultado NUnit .xml.')
      const file = load(c, a.path), body = diagBody(c, file, a)
      return { text: page(file.rel, h16(file.hash + body), body, a, lim, 'Só padrões reconhecidos; caminhos externos ocultados.'), isError: false }
    }
    return fail('Ferramenta Unity desconhecida.')
  } catch (error: any) { return { text: `Erro: ${String(error?.message ?? error).slice(0, 500)}`, isError: true } }
}

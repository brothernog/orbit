// Unity local: YAML textual (cenas, prefabs, assets), índice GUID/.meta e diagnósticos de log/NUnit. Sem banco e sem executar a engine.
import fs from 'node:fs'
import path from 'node:path'

// Credenciais de assinatura nunca são lidas, listadas nem varridas.
export const CREDENTIAL = /\.(?:keystore|jks|p12|pfx)$|^credentials?(?:\.\w+)?$/i

// ---------- YAML Unity (Force Text) ----------
export type UnityField = { key: string; line: number; end: number } // linhas 1-based, inclusivas
export type UnityDoc = { classId: number; id: string; type: string; stripped: boolean; line: number; end: number; fields: UnityField[] }
export type UnityYaml = { lines: string[]; docs: UnityDoc[]; byId: Map<string, UnityDoc>; warnings: string[] }
export type Ref = { fileID: string; guid?: string; type?: string }

const HEAD = /^--- !u!(\d+) &(-?\d+)( stripped)?\s*$/
const TOP = /^ {2}([^\s\-#{[][^:]*?):(?: (.*))?$/
export function parseUnityYaml(text: string): UnityYaml {
  const lines = text.split(/\r?\n/), docs: UnityDoc[] = [], warnings: string[] = []
  if (!/^(?:%YAML|--- !u!)/.test(lines[0] ?? '')) throw Error('Não é YAML Unity (sem --- !u!). .meta: use unity_refs; asset binário: exige Force Text em Editor Settings.')
  let doc: UnityDoc | undefined, field: UnityField | undefined, bad = 0
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i], h = HEAD.exec(s)
    if (h) { doc = { classId: +h[1], id: h[2], type: '', stripped: !!h[3], line: i + 1, end: i + 1, fields: [] }; docs.push(doc); field = undefined; continue }
    if (!doc || s.startsWith('%')) continue
    if (!doc.type && /^[A-Za-z_]\w*:\s*$/.test(s)) { doc.type = s.trim().slice(0, -1); doc.end = i + 1; continue }
    const m = doc.type ? TOP.exec(s) : null
    if (m) { field = { key: m[1], line: i + 1, end: i + 1 }; doc.fields.push(field); doc.end = i + 1; continue }
    if (field && (s === '' || /^ {2}(?: |-(?: |$))/.test(s))) { if (s) field.end = doc.end = i + 1; continue }
    if (s.trim()) bad++
  }
  const byId = new Map<string, UnityDoc>()
  for (const d of docs) { if (byId.has(d.id)) warnings.push(`fileID &${d.id} duplicado; seleção por fileID ambígua.`); byId.set(d.id, d) }
  if (bad) warnings.push(`${bad} linha(s) fora do formato esperado; confira com property/read_file_range.`)
  return { lines, docs, byId, warnings }
}
export const fieldOf = (d: UnityDoc, key: string) => d.fields.find(f => f.key === key)
export const fieldText = (y: UnityYaml, f: { line: number; end: number }) => y.lines.slice(f.line - 1, f.end).join('\n')
export const docText = (y: UnityYaml, d: UnityDoc) => y.lines.slice(d.line - 1, d.end).join('\n')
export function refs(text: string): Ref[] {
  return [...text.matchAll(/\{fileID: (-?\d+)(?:, guid: ([0-9a-f]{32}))?(?:, type: (-?\d+))?\s*\}/g)].map(m => ({ fileID: m[1], guid: m[2], type: m[3] }))
}
export const refOf = (y: UnityYaml, d: UnityDoc, key: string): Ref | undefined => { const f = fieldOf(d, key); return f ? refs(fieldText(y, f))[0] : undefined }
export const valueOf = (y: UnityYaml, d: UnityDoc, key: string): unknown => { const f = fieldOf(d, key); return f ? yamlValue(y.lines.slice(f.line - 1, f.end)) : undefined }

// Campo aninhado por caminho a.b.c (também chaves de itens "- chave:"): devolve as linhas brutas (inclui a chave).
export function rawAt(y: UnityYaml, d: UnityDoc, dotted: string): { line: number; end: number } | undefined {
  const [first, ...rest] = dotted.split('.'), f = fieldOf(d, first)
  if (!f) return
  let span = { line: f.line, end: f.end }, indent = 2
  for (const key of rest) {
    let found: typeof span | undefined
    for (let i = span.line; i < span.end && !found; i++) {
      const s = y.lines[i], item = /^\s*- /.test(s), n = s.length - s.trimStart().length + (item ? 2 : 0)
      if (n <= indent || !s.slice(n).startsWith(key + ':') || !/^:(?: |$)/.test(s.slice(n + key.length))) continue
      let e = i
      while (e + 1 < span.end) { const t = y.lines[e + 1], k = t.length - t.trimStart().length; if (t.trim() && (k < n || k === n && !/^- |^-$/.test(t.trimStart()))) break; e++ }
      found = { line: i + 1, end: e + 1 }; indent = n
    }
    if (!found) return
    span = found
  }
  return span
}

// Parser genérico mínimo: mapas por indentação, listas no estilo Unity (mesmo recuo da chave), fluxo {a: b} e [..]. Escalares ficam string.
const KEY = /^((?:[^\s{[\]}'"#&*!|>%@`,-]|-(?=\S))[^:]*?|'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"):(?: +(.*)|\s*)$/
const indentOf = (s: string) => s.length - s.trimStart().length
export function yamlValue(fieldLines: string[]): unknown {
  const L = [...fieldLines], p = { i: 0 }
  const out = block(L, p, indentOf(L[0] ?? '')) as Record<string, unknown> | null
  return out && typeof out === 'object' && !Array.isArray(out) ? Object.values(out)[0] : out
}
function skipBlank(L: string[], p: { i: number }) { while (p.i < L.length && !L[p.i].trim()) p.i++ }
function block(L: string[], p: { i: number }, n: number): unknown {
  skipBlank(L, p)
  if (p.i >= L.length) return null
  return /^-(?: |$)/.test(L[p.i].trimStart()) ? seq(L, p, indentOf(L[p.i])) : map(L, p, n)
}
function seq(L: string[], p: { i: number }, n: number): unknown[] {
  const out: unknown[] = []
  for (skipBlank(L, p); p.i < L.length && indentOf(L[p.i]) === n && /^-(?: |$)/.test(L[p.i].trimStart()); skipBlank(L, p)) {
    const rest = L[p.i].trimStart().slice(2)
    if (!rest.trim()) { p.i++; skipBlank(L, p); out.push(p.i < L.length && indentOf(L[p.i]) > n ? block(L, p, indentOf(L[p.i])) : ''); continue }
    L[p.i] = ' '.repeat(n + 2) + rest
    if (KEY.test(rest)) out.push(map(L, p, n + 2))
    else { p.i++; out.push(scalar(rest, cont(L, p, n))) }
  }
  return out
}
function map(L: string[], p: { i: number }, n: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (skipBlank(L, p); p.i < L.length && indentOf(L[p.i]) === n; skipBlank(L, p)) {
    const m = KEY.exec(L[p.i].slice(n))
    if (!m) break
    p.i++
    const key = unquote(m[1]), rest = m[2] ?? ''
    if (rest.trim()) { out[key] = scalar(rest, cont(L, p, n)); continue }
    skipBlank(L, p)
    const next = L[p.i], k = next === undefined ? -1 : indentOf(next)
    out[key] = k > n || k === n && /^-(?: |$)/.test(next.trimStart()) ? block(L, p, k) : ''
  }
  return out
}
function cont(L: string[], p: { i: number }, n: number): string[] {
  const more: string[] = []
  for (let j = p.i; j < L.length; j++) {
    if (!L[j].trim()) continue
    if (indentOf(L[j]) <= n) break
    more.push(...L.slice(p.i, j + 1).map(s => s.trim())); p.i = j + 1
  }
  return more
}
function scalar(first: string, more: string[]): unknown {
  const q = first.trim()[0]
  const s = [first.trim(), ...more].reduce((a, b) => b === '' ? a + '\n' : q === '"' && a.endsWith('\\') ? a.slice(0, -1) + b : a.endsWith('\n') || !a ? a + b : a + ' ' + b)
  if (/^[{[]/.test(s)) { try { return flow(s, { i: 0 }) } catch { return s } }
  return unquote(s)
}
export function unquote(s: string): string {
  s = s.trim()
  if (s.length > 1 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s.length > 1 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e: string) => e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ n: '\n', t: '\t', r: '\r', '0': '\0' } as Record<string, string>)[e] ?? e)
  }
  return s
}
function flow(s: string, p: { i: number }): unknown {
  const ws = () => { while (s[p.i] === ' ') p.i++ }
  ws()
  const open = s[p.i]
  if (open === '{' || open === '[') {
    p.i++
    const obj: Record<string, unknown> = {}, arr: unknown[] = []
    for (ws(); s[p.i] !== (open === '{' ? '}' : ']'); ws()) {
      const at = p.i
      if (p.i >= s.length) throw Error('fluxo incompleto')
      if (open === '{') {
        const k = /^([^:,}]+):\s?/.exec(s.slice(p.i)) ?? fail('chave')
        p.i += k[0].length; obj[unquote(k[1])] = flow(s, p)
      } else arr.push(flow(s, p))
      ws(); if (s[p.i] === ',') p.i++
      if (p.i === at) throw Error('fluxo inválido')
    }
    p.i++
    return open === '{' ? obj : arr
  }
  const m = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^,}\]]*)/.exec(s.slice(p.i))!
  p.i += m[0].length
  return unquote(m[0])
}
const fail = (m: string): never => { throw Error(m) }
const text = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)

// ---------- Hierarquia de cena/prefab ----------
export type UnityNode = { id: string; kind: 'go' | 'prefab'; name: string; active: boolean; doc: UnityDoc; transform?: UnityDoc; comps: UnityDoc[]; children: UnityNode[]; parent?: UnityNode; line: number; source?: Ref; mods?: number }
export type UnityTree = { roots: UnityNode[]; nodes: UnityNode[]; owner: Map<string, UnityNode>; other: UnityDoc[]; stripped: number; warnings: string[] }
export const isTransform = (d: UnityDoc) => d.type === 'Transform' || d.type === 'RectTransform'
// Formato ≤2018.2: o doc "Prefab" também marca o próprio asset; só é instância quando aponta m_ParentPrefab.
const isInstance = (y: UnityYaml, d: UnityDoc) => d.classId === 1001 && (d.type === 'PrefabInstance' || d.type === 'Prefab' && !!refOf(y, d, 'm_ParentPrefab')?.guid)
const ranker = (ids: (string | UnityNode | undefined)[]) => { const m = new Map<unknown, number>(); ids.forEach((x, i) => { if (x !== undefined && !m.has(x)) m.set(x, i) }); return (x: unknown) => m.get(x) ?? 1e9 }

// rootGo(guid): fileID do GameObject raiz da prefab de origem, quando legível; sem ele, nome/atividade da instância vêm do único alvo de m_Name.
export function unityTree(y: UnityYaml, rootGo?: (guid: string) => string | undefined): UnityTree {
  const nodes: UnityNode[] = [], owner = new Map<string, UnityNode>(), byGo = new Map<string, UnityNode>(), byPI = new Map<string, UnityNode>(), warnings: string[] = []
  for (const d of y.docs) {
    if (d.stripped) continue
    if (d.type === 'GameObject') {
      const n: UnityNode = { id: d.id, kind: 'go', name: text(valueOf(y, d, 'm_Name')), active: text(valueOf(y, d, 'm_IsActive')) !== '0', doc: d, comps: [], children: [], line: d.line }
      nodes.push(n); byGo.set(d.id, n); owner.set(d.id, n)
    } else if (isInstance(y, d)) {
      const m = valueOf(y, d, 'm_Modification') as any, mods: any[] = Array.isArray(m?.m_Modifications) ? m.m_Modifications : []
      const source = refOf(y, d, 'm_SourcePrefab') ?? refOf(y, d, 'm_ParentPrefab'), names = mods.filter(x => x?.propertyPath === 'm_Name')
      const root = (source?.guid && rootGo?.(source.guid)) || (new Set(names.map(x => x?.target?.fileID)).size === 1 ? names[0].target.fileID : undefined)
      const at = (prop: string) => mods.find(x => x?.propertyPath === prop && x?.target?.fileID === root)?.value
      const n: UnityNode = { id: d.id, kind: 'prefab', name: root ? text(at('m_Name')) : '', active: !root || text(at('m_IsActive')) !== '0', doc: d, comps: [], children: [], line: d.line, source, mods: mods.length }
      nodes.push(n); byPI.set(d.id, n); owner.set(d.id, n)
    }
  }
  const instanceOf = (d: UnityDoc | undefined) => d?.stripped ? byPI.get((refOf(y, d, 'm_PrefabInstance') ?? refOf(y, d, 'm_PrefabInternal'))?.fileID ?? '') : undefined
  const ofTransform = (tid: string) => { const t = y.byId.get(tid); return !t ? undefined : t.stripped ? instanceOf(t) : byGo.get(refOf(y, t, 'm_GameObject')?.fileID ?? '') }
  let stripped = 0
  for (const d of y.docs) {
    if (d.stripped) { stripped++; const n = instanceOf(d); if (n) owner.set(d.id, n); else warnings.push(`&${d.id} stripped sem PrefabInstance no arquivo.`); continue }
    if (d.type === 'GameObject' || isInstance(y, d)) continue
    const go = refOf(y, d, 'm_GameObject')?.fileID
    if (!go || go === '0') continue
    const n = byGo.get(go) ?? instanceOf(y.byId.get(go))
    if (!n) { warnings.push(`Componente ${d.type} &${d.id} aponta GameObject &${go} inexistente.`); continue }
    owner.set(d.id, n)
    if (isTransform(d) && n.kind === 'go' && !n.transform) n.transform = d
    else n.comps.push(d)
  }
  for (const n of byGo.values()) {
    const r = ranker(refs(fieldText(y, fieldOf(n.doc, 'm_Component') ?? { line: 0, end: -1 })).map(r => r.fileID))
    n.comps.sort((a, b) => r(a.id) - r(b.id) || a.line - b.line)
    if (!n.transform) warnings.push(`GameObject "${n.name}" &${n.id} sem Transform.`)
  }
  const roots: UnityNode[] = []
  for (const n of nodes) {
    const tid = n.kind === 'go' ? (n.transform ? refOf(y, n.transform, 'm_Father')?.fileID : undefined) : /m_TransformParent: \{fileID: (-?\d+)/.exec(fieldText(y, fieldOf(n.doc, 'm_Modification') ?? { line: 0, end: -1 }))?.[1]
    if (tid && tid !== '0') { n.parent = ofTransform(tid); if (!n.parent) warnings.push(`Pai &${tid} de "${n.name}" não encontrado; listado na raiz.`) }
  }
  for (const n of nodes) { // ciclos em YAML corrompido viram raiz
    const seen = new Set<UnityNode>()
    for (let p = n.parent; p; p = p.parent) { if (p === n || seen.has(p)) { warnings.push(`Ciclo de hierarquia em &${n.id}.`); n.parent = undefined; break } seen.add(p) }
  }
  for (const n of nodes) (n.parent ? n.parent.children : roots).push(n)
  const rank = (list: UnityNode[], ids: string[]) => { const r = ranker(ids.map(ofTransform)); list.sort((a, b) => r(a) - r(b) || a.line - b.line) }
  for (const n of nodes) if (n.children.length > 1 && n.transform) rank(n.children, refs(fieldText(y, fieldOf(n.transform, 'm_Children') ?? { line: 0, end: -1 })).map(r => r.fileID))
  const sceneRoots = y.docs.find(d => d.type === 'SceneRoots')
  if (sceneRoots) rank(roots, refs(fieldText(y, fieldOf(sceneRoots, 'm_Roots') ?? { line: 0, end: -1 })).map(r => r.fileID))
  else {
    const order = (n: UnityNode) => Number(n.transform ? valueOf(y, n.transform, 'm_RootOrder') : /propertyPath: m_RootOrder\r?\n\s*value: ?(-?\d+)/.exec(fieldText(y, fieldOf(n.doc, 'm_Modification') ?? { line: 0, end: -1 }))?.[1]) || 0
    roots.sort((a, b) => order(a) - order(b) || a.line - b.line)
  }
  const other = y.docs.filter(d => !owner.has(d.id) && !d.stripped)
  return { roots, nodes, owner, other, stripped, warnings }
}
export const nodePath = (n: UnityNode): string => (n.parent ? nodePath(n.parent) + '/' : '') + (n.name || `&${n.id}`)

// GUIDs de pacotes Unity conhecidos (Library/PackageCache não é lido). Rótulo só quando o GUID é público e estável.
export const KNOWN_SCRIPTS: Record<string, string> = {
  fe87c0e1cc204ed48ad3b37840f39efc: 'UI.Image', '5f7201a12d95ffc409449d95f23cf332': 'UI.Text', '4e29b1a8efbd4b44bb3f3716e73f07ff': 'UI.Button',
  '0cd44c1031e13a943bb63640046fad76': 'UI.CanvasScaler', dc42784cf147c0c48a680349fa168899: 'UI.GraphicRaycaster', '76c392e42b5098c458856cdf6ecaaaa1': 'EventSystem',
  '4f231c4fb786f3946a6b90b886c48677': 'StandaloneInputModule', '1344c3c82d62a2a41a3576d8abb8e3ea': 'UI.RawImage', '9085046f02f69544eb97fd06b6048fe2': 'UI.Toggle',
  '67db9e8f0e2ae9c40bc1e2b64352a6b4': 'UI.Slider', '1aa08ab6e0800fa44ae55d278d1423e3': 'UI.ScrollRect', '31a19414c41e5ae4aae2af33fee712f6': 'UI.Mask',
  '30649d3a9faa99c48a7b1166b86bf2a0': 'UI.HorizontalLayoutGroup', '59f8146938fff824cb5fd77236b75775': 'UI.VerticalLayoutGroup', '8a8695521f0d02e499659fee002a26c2': 'UI.GridLayoutGroup',
  '3245ec927659c4140ac4f8d17403cc18': 'UI.ContentSizeFitter', '306cc8c2b49d7114eaa3623786fc2126': 'UI.LayoutElement', f4688fdb7df04437aeb418b961361dc5: 'TMPro.TextMeshProUGUI',
  '9541d86e2fd84c1d9990edf0852d74ab': 'TMPro.TextMeshPro', '2da0c512f12947e489f739169773d7ca': 'TMPro.TMP_InputField', '7b743370ac3e4ec2a1668f5455a8ef8a': 'TMPro.TMP_Dropdown',
  a79441f348de89743a2939f4d699eac1: 'URP.UniversalAdditionalCameraData', '474bcb49853aa07438625e644c072ee6': 'URP.UniversalAdditionalLightData',
  '01614664b831546d2ae94a42149d80ac': 'InputSystemUIInputModule', '62899f850307741f2a39c98a8b639597': 'InputSystem.PlayerInput'
}
export const BUILTIN_GUIDS: Record<string, string> = { '0000000000000000e000000000000000': 'built-in: unity default resources', '0000000000000000f000000000000000': 'built-in: unity_builtin_extra', '0000000000000000d000000000000000': 'built-in: editor resources' }

// ---------- Índice do projeto: .meta (guid próprio) e citações de GUID por arquivo ----------
export type FileRec = { size: number; mtimeMs: number; own?: string | null; refs?: Map<string, number> | null; why?: string }
export type UnityIndex = { at: number; files: Map<string, FileRec>; byGuid: Map<string, string>; truncated: boolean; links: number; hidden: string[]; usages: boolean }
const BINARY = /\.(?:png|jpe?g|tga|psd|tiff?|exr|hdr|bmp|gif|webp|ico|fbx|obj|blend|max|mb|ma|dae|3ds|wav|mp3|ogg|aiff?|flac|mp4|mov|webm|avi|dll|so|dylib|a|lib|pdb|mdb|ttf|otf|bytes|zip|7z|gz|unitypackage|bank|pdf|jar|aar|bundle|dds|ktx|astc|cubemap|terraindata|lighting|bin)$/i
export const MAX_SCAN = 32 * 1024 * 1024
const MAX_ENTRIES = 100_000, TTL = 2000
const indexes = new Map<string, UnityIndex>()
// Varre Assets/ e Packages/ como o Unity importa (ignora ".*" e "*~"), sem seguir links. Pastas com nome interno ficam em hidden.
// usages=true revarre sempre (consulta de segurança) e conta GUIDs citados em arquivos texto; nomes/rotulos usam cache curto.
export function unityIndex(root: string, internal: string[], usages = false): UnityIndex {
  const key = path.resolve(root), prev = indexes.get(key)
  if (prev && !usages && Date.now() - prev.at < TTL) return prev
  const files = new Map<string, FileRec>(), hidden: string[] = []
  let entries = 0, truncated = false, links = 0
  const visit = (rel: string) => {
    let list: fs.Dirent[]
    try { list = fs.readdirSync(path.join(key, rel), { withFileTypes: true }) } catch { return }
    for (const e of list) {
      if (++entries > MAX_ENTRIES) { truncated = true; return }
      const r = rel + '/' + e.name
      if (e.isSymbolicLink()) { links++; continue }
      if (e.name.startsWith('.') || e.name.endsWith('~') || CREDENTIAL.test(e.name)) continue
      if (internal.includes(e.name)) { if (e.isDirectory()) hidden.push(r); continue }
      if (e.isDirectory()) { visit(r); continue }
      if (!e.isFile()) continue
      let st: fs.Stats
      try { st = fs.statSync(path.join(key, r)) } catch { continue }
      const old = prev?.files.get(r), same = old && old.size === st.size && old.mtimeMs === st.mtimeMs
      files.set(r, same ? old : { size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  for (const top of ['Assets', 'Packages']) visit(top)
  const byGuid = new Map<string, string>()
  for (const [rel, f] of files) {
    const meta = rel.endsWith('.meta')
    if (meta && f.own === undefined) f.own = f.size > 1024 * 1024 ? null : /^guid: ([0-9a-f]{32})\s*$/m.exec(read(key, rel)?.toString('utf8') ?? '')?.[1] ?? null
    if (meta && f.own) byGuid.set(f.own, rel.slice(0, -5))
    if (usages && f.refs === undefined) {
      if (BINARY.test(rel)) { f.refs = null; f.why = 'binário' } else if (f.size > MAX_SCAN) { f.refs = null; f.why = '> 32 MiB' } else {
        const b = read(key, rel)
        if (!b || b.includes(0)) { f.refs = null; f.why = 'binário' } else {
          const counts = new Map<string, number>()
          for (const m of b.toString('latin1').matchAll(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
          f.refs = counts
        }
      }
    }
  }
  const index: UnityIndex = { at: Date.now(), files, byGuid, truncated, links, hidden, usages: [...files.values()].every(f => f.refs !== undefined) }
  indexes.set(key, index)
  if (indexes.size > 20) indexes.delete(indexes.keys().next().value as string)
  return index
}
const read = (root: string, rel: string) => { try { return fs.readFileSync(path.join(root, rel)) } catch { return null } }

// ---------- Metadados do projeto ----------
export type UnityPackage = { name: string; version: string; source: 'registry' | 'local' | 'git' | 'embedded' }
export type UnityAsmdef = { name: string; path: string; test: boolean; editor: boolean }
export type UnityProjectInfo = {
  editor: string | null; revision: string | null; product: string | null; company: string | null; version: string | null
  serialization: number | null; input: string | null; backends: Record<string, string>; defines: Record<string, string>
  pipeline: { kind: string; asset?: Ref }; packages: UnityPackage[]; modules: number; scenes: { path: string; enabled: boolean; guid: string }[]
  asmdefs: UnityAsmdef[]; tags: string[]; layers: string[]; sortingLayers: string[]; counts: Record<string, number>; warnings: string[]
}
const INPUT = ['Input Manager (antigo)', 'Input System (novo)', 'ambos']
const BACKEND: Record<string, string> = { '0': 'Mono', '1': 'IL2CPP', '2': 'WinRT' }
// read lança se ausente/fora do escopo; files são caminhos relativos já autorizados.
export function unityProject(read: (rel: string) => string, files: string[]): UnityProjectInfo {
  const warnings: string[] = []
  const load = (rel: string, label: string) => { try { return read(rel) } catch (e: any) { warnings.push(`${label} ${e?.code === 'ENOENT' ? 'ausente' : 'não lido: ' + String(e?.message ?? e).slice(0, 120)}.`); return null } }
  const asset = (rel: string) => { const t = load(rel, rel); if (t === null) return null; try { const y = parseUnityYaml(t); const d = y.docs[0] ?? fail('vazio'); return { y, d, v: (k: string) => valueOf(y, d, k), r: (k: string) => refOf(y, d, k) } } catch (e: any) { warnings.push(`${rel}: ${e.message}`); return null } }
  const info: UnityProjectInfo = { editor: null, revision: null, product: null, company: null, version: null, serialization: null, input: null, backends: {}, defines: {}, pipeline: { kind: 'desconhecido' }, packages: [], modules: 0, scenes: [], asmdefs: [], tags: [], layers: [], sortingLayers: [], counts: {}, warnings }
  const ver = load('ProjectSettings/ProjectVersion.txt', 'ProjectVersion.txt')
  info.editor = ver?.match(/^m_EditorVersion: *(\S+)/m)?.[1] ?? null
  info.revision = ver?.match(/^m_EditorVersionWithRevision: *\S+ \((\w+)\)/m)?.[1] ?? null
  if (ver !== null && !info.editor) warnings.push('m_EditorVersion ausente em ProjectVersion.txt.')
  const ps = asset('ProjectSettings/ProjectSettings.asset')
  if (ps) {
    info.product = text(ps.v('productName')) || null; info.company = text(ps.v('companyName')) || null; info.version = text(ps.v('bundleVersion')) || null
    const ih = text(ps.v('activeInputHandler')); info.input = ih ? INPUT[+ih] ?? `activeInputHandler ${ih}` : 'Input Manager (antigo; campo ausente)'
    const map = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
    for (const [k, v] of Object.entries(map(ps.v('scriptingBackend')))) info.backends[k] = BACKEND[text(v)] ?? text(v)
    for (const [k, v] of Object.entries(map(ps.v('scriptingDefineSymbols')))) if (text(v)) info.defines[k] = text(v)
  }
  const es = asset('ProjectSettings/EditorSettings.asset')
  if (es) { const m = text(es.v('m_SerializationMode')); info.serialization = m === '' ? null : Number(m) }
  const manifest = load('Packages/manifest.json', 'Packages/manifest.json')
  if (manifest !== null) {
    try {
      const deps = JSON.parse(manifest).dependencies ?? {}
      for (const [name, v] of Object.entries(deps)) {
        const version = String(v)
        if (name.startsWith('com.unity.modules.')) { info.modules++; continue }
        info.packages.push({ name, version, source: version.startsWith('file:') ? 'local' : /^(?:git\+|git@|ssh:|https?:)|\.git(?:#|$)/.test(version) ? 'git' : 'registry' })
      }
    } catch { warnings.push('Packages/manifest.json inválido.') }
  }
  for (const f of files) {
    const m = /^Packages\/([^/]+)\/package\.json$/.exec(f)
    if (m && !info.packages.some(p => p.name === m[1])) info.packages.push({ name: m[1], version: '', source: 'embedded' })
  }
  info.packages.sort((a, b) => a.name.localeCompare(b.name))
  const has = (n: string) => info.packages.some(p => p.name === n)
  const gs = asset('ProjectSettings/GraphicsSettings.asset'), qs = asset('ProjectSettings/QualitySettings.asset')
  const srp = [gs?.r('m_CustomRenderPipeline'), ...(qs ? refs(fieldText(qs.y, fieldOf(qs.d, 'm_QualitySettings') ?? { line: 0, end: -1 }).split('\n').filter(l => /customRenderPipeline:/.test(l)).join('\n')) : [])].find(r => r?.guid)
  const pkg = has('com.unity.render-pipelines.high-definition') ? 'HDRP' : has('com.unity.render-pipelines.universal') ? 'URP' : null
  info.pipeline = srp ? { kind: pkg ?? 'SRP (pacote não identificado)', asset: srp } : { kind: pkg ? `${pkg} instalado, sem asset em Graphics/Quality (renderiza Built-in?)` : gs ? 'Built-in' : 'desconhecido' }
  const eb = asset('ProjectSettings/EditorBuildSettings.asset')
  const scenes = eb?.v('m_Scenes')
  if (Array.isArray(scenes)) info.scenes = scenes.map((s: any) => ({ path: text(s?.path), enabled: text(s?.enabled) === '1', guid: text(s?.guid) }))
  const tm = asset('ProjectSettings/TagManager.asset')
  if (tm) {
    const list = (v: unknown) => Array.isArray(v) ? v.map(text) : []
    info.tags = list(tm.v('tags')); info.layers = list(tm.v('layers'))
    const sl = tm.v('m_SortingLayers'); info.sortingLayers = Array.isArray(sl) ? sl.map((s: any) => text(s?.name)) : []
  }
  for (const f of files.filter(f => f.endsWith('.asmdef'))) {
    const t = load(f, f)
    if (t === null) continue
    try {
      const j = JSON.parse(t), all = [...(j.defineConstraints ?? []), ...(j.optionalUnityReferences ?? []), ...(j.references ?? [])].map(String)
      info.asmdefs.push({ name: String(j.name ?? path.basename(f, '.asmdef')), path: f, test: all.some(x => /^UNITY_INCLUDE_TESTS$|^TestAssemblies$|^UnityEngine\.TestRunner$|^GUID:27619889b8ba8c24980f49ee34dbb44a$/.test(x)), editor: Array.isArray(j.includePlatforms) && j.includePlatforms.length === 1 && j.includePlatforms[0] === 'Editor' })
    } catch { warnings.push(`${f}: JSON inválido.`) }
  }
  for (const e of ['cs', 'unity', 'prefab', 'asset', 'mat', 'shader', 'shadergraph', 'anim', 'controller', 'asmdef']) { const k = files.filter(f => f.startsWith('Assets/') && f.endsWith('.' + e)).length; if (k) info.counts[e] = k }
  return info
}

// ---------- Diagnósticos: Editor.log / -logFile e NUnit XML (-testResults) ----------
export type UnityDiag = { severity: 'error' | 'warning' | 'info'; kind: string; code?: string; message: string; file?: string; line?: number; col?: number; frame?: string; stack: string[]; count: number; lines: number[] }
// Caminhos absolutos de projeto (inclusive de outra máquina/CI) viram Assets/…, Packages/… ou Library/PackageCache/….
export const projectRel = (p: string) => { const s = p.replace(/\\/g, '/'); return /^(?:[a-z]:\/|\/)/i.test(s) ? /\/((?:Assets|Packages|Library\/PackageCache)\/.*)$/.exec(s)?.[1] ?? s : s }
// Em texto livre: o prefixo da máquina some antes de Assets/, Packages/ ou Library/PackageCache/ (o resto de caminhos absolutos é ocultado pelas ferramentas).
export const projectPaths = (t: string) => t.replace(/(?<![\w.])(?:[a-z]:)?[\\/](?:[^:()"'<>|\\/\n]+[\\/])*?((?:Assets|Packages|Library[\\/]PackageCache)[\\/][^\s:()"'<>|]*)/gi, (_, rel: string) => rel.replace(/\\/g, '/'))
const FRAME = /^\s*at .+|\(at .+:\d+\)\s*$|^[\w.<>`+$[\],]+:[\w.<>`+$|]+ ?\(.*\)|^Rethrow as \w+/
const EXC = /^([\w.]*[A-Z]\w*Exception)(?:: ?(.*))?$/
const CS = /^(?:\[[^\]]*\]\s*)*(.+?\.cs)\((\d+),(\d+)\): (error|warning) (\w+): (.*)$/i
const LOC = /((?:[a-z]:)?[^\s()]*?(?:Assets|Packages)[/\\][^:()]+?):(\d+)\)?\s*$/i
function projectFrame(stack: string[]) {
  const hits = stack.map(f => ({ f, m: LOC.exec(f) })).filter(x => x.m)
  const best = hits.find(x => /(?:^|[/\\ (])Assets[/\\]/.test(x.m![1])) ?? hits.find(x => !/Packages[/\\]com\.unity\./.test(x.m![1])) ?? hits[0]
  return best ? { frame: best.f.trim(), file: projectRel(best.m![1]), line: Number(best.m![2]) } : {}
}
export function unityLog(raw: string): { items: UnityDiag[]; totalLines: number } {
  const lines = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(l => projectPaths(l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\|0x[0-9a-f]+\|/i, '')))
  const found: UnityDiag[] = []
  const add = (d: Omit<UnityDiag, 'count' | 'stack'> & { stack?: string[] }) => found.push({ stack: [], count: 1, ...d })
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue }
    const start = i, block: string[] = [], used = new Set<number>()
    while (i < lines.length && lines[i].trim()) block.push(lines[i++])
    const at = (k: number) => [start + k + 1]
    for (let j = 0; j < block.length; j++) {
      const l = block[j].trim(), j0 = j, before = found.length
      let m: RegExpExecArray | null
      if ((m = CS.exec(l))) add({ severity: m[4].toLowerCase() as 'error' | 'warning', kind: 'compilação', code: m[5], message: m[6], file: projectRel(m[1]), line: +m[2], col: +m[3], lines: at(j) })
      else if ((m = /^Shader (error|warning) in '([^']+)': (.*)$/.exec(l))) add({ severity: m[1] as 'error' | 'warning', kind: 'shader', code: m[2], message: m[3], lines: at(j) })
      else if ((m = /Build Finished, Result: (\w+)|Build completed with a result of '(\w+)'/.exec(l))) add({ severity: /^Succe/.test(m[1] ?? m[2]) ? 'info' : 'error', kind: 'build', message: l, lines: at(j) })
      else if (/^Error building Player|^Build failed|BuildPlayerWindow\+BuildMethodException/.test(l)) add({ severity: 'error', kind: 'build', message: [l, ...block.slice(j + 1, j + 3).map(s => s.trim())].join(' '), lines: at(j) })
      else if (/^Scripts have compiler errors/.test(l)) add({ severity: 'error', kind: 'compilação', message: l, lines: at(j) })
      else if (/^Aborting batchmode due to failure/.test(l)) { add({ severity: 'error', kind: 'batchmode', message: [l, ...block.slice(j + 1, j + 2).map(s => s.trim())].join(' '), lines: at(j) }); used.add(++j) }
      else if (/^Exiting batchmode successfully|^Test run completed|Exiting with code \d+|^Saving results to:/.test(l)) add({ severity: /code [1-9]|Failed/.test(l) ? 'error' : 'info', kind: /results|Test run/.test(l) ? 'testes' : 'batchmode', message: l, lines: at(j) })
      else if (/^An error occurred while resolving packages|^\[Package Manager\].*(?:error|fail)|^Cannot resolve package/i.test(l)) { add({ severity: 'error', kind: 'pacotes', message: [l, ...block.slice(j + 1, j + 6).map(s => s.trim())].join(' | '), lines: at(j) }); for (let k = 0; k < 5 && j + 1 < block.length; k++) used.add(++j) }
      else if (/licen[sc]/i.test(l) && /error|fail|no valid|not found|invalid|expired|could not/i.test(l)) add({ severity: 'error', kind: 'licença', message: l, lines: at(j) })
      if (found.length > before) used.add(j0)
    }
    // Pilhas: a mensagem são até 6 linhas não classificadas logo acima; exceção se houver cabeçalho *Exception, senão Debug.Log*.
    for (let j = 0; j < block.length; j++) {
      if (used.has(j) || !FRAME.test(block[j])) continue
      let e = j, s = j
      while (e + 1 < block.length && FRAME.test(block[e + 1])) e++
      while (s > 0 && !used.has(s - 1) && j - s < 6) s--
      const stack = block.slice(j, e + 1).map(x => x.trim()), h = block.slice(s, j).findIndex(x => EXC.test(x.trim())), log = /^UnityEngine\.Debug:Log(Error|Warning|Exception|Assertion)/.exec(stack[0])
      if (h >= 0) { const ex = EXC.exec(block[s + h].trim())!; add({ severity: 'error', kind: 'exceção', code: ex[1].split('.').pop(), message: [ex[2] ?? '', ...block.slice(s + h + 1, j)].join('\n').trim() || ex[1], stack, ...projectFrame(stack), lines: at(s + h) }) }
      else if (log && s < j) add({ severity: log[1] === 'Warning' ? 'warning' : 'error', kind: `Log${log[1]}`, message: block.slice(s, j).join('\n').trim(), stack, ...projectFrame(stack), lines: at(s) })
      for (let k = s; k <= e; k++) used.add(k)
      j = e
    }
    for (let j = 0; j < block.length; j++) {
      const ex = used.has(j) ? null : EXC.exec(block[j].trim())
      if (ex) add({ severity: 'error', kind: 'exceção', code: ex[1].split('.').pop(), message: ex[2] || ex[1], lines: at(j) })
    }
  }
  const grouped = new Map<string, UnityDiag>()
  for (const d of found) {
    const key = JSON.stringify([d.severity, d.kind, d.code, d.message, d.file, d.line, d.frame]), prev = grouped.get(key)
    if (prev) { prev.count++; if (prev.lines.length < 50) prev.lines.push(...d.lines) } else grouped.set(key, d)
  }
  const rank = { error: 0, warning: 1, info: 2 }
  return { items: [...grouped.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || a.lines[0] - b.lines[0]), totalLines: lines.length }
}

type X = { tag: string; attrs: Record<string, string>; kids: X[]; text: string; line: number }
const entity = (s: string) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi, (m, h, d, n) => h ? String.fromCodePoint(parseInt(h, 16)) : d ? String.fromCodePoint(+d) : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[n.toLowerCase()] ?? m)
function xmlTree(s: string): X {
  const root: X = { tag: '#', attrs: {}, kids: [], text: '', line: 1 }, stack = [root]
  let line = 1, last = 0
  for (const m of s.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g)) {
    for (let i = last; i < m.index!; i++) if (s.charCodeAt(i) === 10) line++
    last = m.index!
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.text += m[1]
    else if (m[6] !== undefined) top.text += entity(m[6])
    else if (m[3] && m[2]) { const i = stack.map(x => x.tag).lastIndexOf(m[3]); if (i > 0) stack.length = i }
    else if (m[3]) {
      const el: X = { tag: m[3], attrs: {}, kids: [], text: '', line }
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1]] = entity(a[2] ?? a[3])
      top.kids.push(el)
      if (!m[5]) stack.push(el)
    }
  }
  return root
}
const kid = (x: X | undefined, tag: string) => x?.kids.find(k => k.tag === tag)
export type UnityTests = { result: string; total: number; passed: number; failed: number; skipped: number; inconclusive: number; duration: number | null; items: UnityDiag[] }
export function unityTestResults(xml: string): UnityTests {
  const root = xmlTree(xml), run = kid(root, 'test-run') ?? fail('XML sem <test-run>: não é resultado NUnit 3 do Unity Test Runner.')
  const n = (k: string) => Number(run.attrs[k] ?? 0) || 0, items: UnityDiag[] = []
  const walk = (x: X) => {
    for (const k of x.kids) {
      const r = k.attrs.result ?? ''
      if (k.tag === 'test-case' || k.tag === 'test-suite' && /^(?:SetUp|TearDown)$/.test(k.attrs.site ?? '')) {
        const f = kid(k, 'failure') ?? kid(k, 'reason'), message = projectPaths((kid(f, 'message')?.text ?? '').trim()), stack = projectPaths(kid(f, 'stack-trace')?.text ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        const name = k.attrs.fullname ?? k.attrs.name ?? '?', output = kid(k, 'output')?.text.trim()
        if (r === 'Failed') items.push({ severity: 'error', kind: k.tag === 'test-case' ? (k.attrs.label === 'Error' ? 'teste com exceção' : 'teste falhou') : `suite ${k.attrs.site}`, code: name, message: message || k.attrs.label || 'Failed', stack: output ? [...stack, '--- output ---', ...output.split(/\r?\n/).slice(0, 40)] : stack, ...projectFrame(stack), count: 1, lines: [k.line] })
        else if (k.tag === 'test-case' && (r === 'Skipped' || r === 'Inconclusive')) items.push({ severity: 'warning', kind: r === 'Skipped' ? 'pulado' : 'inconclusivo', code: name, message: message || k.attrs.label || r, stack: [], count: 1, lines: [k.line] })
      }
      if (k.tag === 'test-suite' || k.tag === 'test-run') walk(k)
    }
  }
  walk(run)
  const d = Number(run.attrs.duration)
  return { result: run.attrs.result ?? '?', total: n('total'), passed: n('passed'), failed: n('failed'), skipped: n('skipped'), inconclusive: n('inconclusive'), duration: Number.isFinite(d) && run.attrs.duration ? d : null, items }
}

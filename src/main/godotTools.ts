// Consultas locais Godot: fontes atuais, sem execução, histórico de agentes ou configuração global.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { sha } from './artifacts.ts'
import { godotDiagnostics, godotOrganizer, godotProject } from './godot.ts'
import { inScope, safeJoin, samePath } from './guard.ts'
import type { ContextLimits } from './limits.ts'
import type { ToolDef, ToolResult } from './mcp.ts'
import type { ToolCtx } from './taskContext.ts'

const pageArgs = { offset: { type: 'integer', minimum: 0 }, hash: { type: 'string', description: 'Hash da resposta anterior ao continuar.' } }
const schema = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
export const GODOT_TOOLS: ToolDef[] = [
  { name: 'godot_project', description: 'Godot local: versão declarada, cena principal, autoloads e presets; só fontes autorizadas. Não executa a engine.', inputSchema: schema(pageArgs) },
  { name: 'godot_scene', description: 'Índice textual .tscn/.tres; node seleciona subárvore (. = raiz), resource seleciona ID/main. property lê valor bruto paginado. Não resolve herança/instâncias/binários.', inputSchema: schema({ path: { type: 'string' }, node: { type: 'string' }, resource: { type: 'string' }, property: { type: 'string' }, ...pageArgs }, ['path']) },
  { name: 'godot_diagnostics', description: 'Agrupa erros de log NATIVO do Godot indicado por path dentro do workspace. detail seleciona índice do erro; raw lê log paginado. Não consulta histórico/logs do dashboard nem user://.', inputSchema: schema({ path: { type: 'string' }, detail: { type: 'integer', minimum: 0 }, raw: { type: 'boolean' }, ...pageArgs }, ['path']) }
]

const fail = (message: string): never => { throw new Error(message) }
const str = (v: unknown, name: string, max = 1000) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail(`${name} inválido.`)
const num = (v: unknown, name: string) => v == null ? 0 : Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : fail(`${name} inválido.`)
const scopes = (values: string[]) => [...new Set(values.map(v => {
  const s = str(v, 'escopo').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.'
  if (/^(?:\/|[a-z]:)/i.test(s) || s.split('/').includes('..')) fail('Escopo inválido.')
  return s
}))].sort()

type Local = { cwd: string; allow: (rel: string) => boolean }
function context(db: DatabaseSync, c: ToolCtx, organizerId: string): Local {
  if (c.auth.taskId !== c.taskId || c.auth.recipient.logicalId !== c.lineage) fail('Identidade de execução incompatível.')
  const cwd = fs.realpathSync(c.cwd)
  if (!samePath(cwd, fs.realpathSync(c.auth.recipient.workspace))) fail('Workspace não autorizado.')
  const scope = scopes(c.scope)
  if (JSON.stringify(scope) !== JSON.stringify(scopes(c.auth.recipient.scope))) fail('Escopo não autorizado.')
  const task = db.prepare('SELECT game,worktree FROM tasks WHERE id=?').get(c.taskId) as { game: string; worktree: string | null } | undefined
  if (!task || !samePath(cwd, task.worktree || task.game)) fail('Workspace incompatível com a tarefa atual.')
  const organizer = task && godotOrganizer(db, task.game)
  if (!organizer || organizer.id !== organizerId || !organizer.config.enabled) fail('Godot indisponível no organizador desta execução.')
  return { cwd, allow: rel => inScope(rel, scope) }
}

function localPath(c: Local, value: unknown): { abs: string; rel: string } {
  const p = str(value, 'path')
  if (/^(?:[\\/]|[a-z]:|\w+:\/\/)/i.test(p) || p.split(/[\\/]/).includes('..')) fail('Caminho fora do workspace.')
  const abs = safeJoin(c.cwd, p), rel = path.relative(c.cwd, abs).split(path.sep).join('/')
  if (rel.split('/').some(p => ['.git', '.godot', '.import', '.worktrees', 'export_credentials.cfg'].includes(p))) fail('Arquivo interno/credencial fora das consultas Godot.')
  if (!c.allow(rel)) fail('Arquivo fora do escopo autorizado.')
  return { abs, rel }
}

function source(c: Local, value: unknown) {
  const f = localPath(c, value)
  if (!fs.statSync(f.abs).isFile()) fail('Não é um arquivo.')
  // ponytail: leitura síncrona até 4 MiB; streaming se projetos reais exigirem arquivos maiores.
  if (fs.statSync(f.abs).size > 4 * 1024 * 1024) fail('Arquivo acima de 4 MiB; use leitura por intervalo ou uma fonte menor.')
  const bytes = fs.readFileSync(f.abs)
  if (bytes.includes(0)) fail('Arquivo binário; esta consulta lê somente texto.')
  const text = bytes.toString('utf8')
  return { ...f, text, hash: sha(bytes), lines: text.split(/\r?\n/).length }
}

function page(label: string, hash: string, body: string, args: any, lim: ContextLimits, note: string) {
  const offset = num(args.offset, 'offset')
  if (offset > 0 && args.hash !== hash) fail('Fonte/consulta mudou ou hash ausente; reinicie sem offset.')
  if (args.hash !== undefined && args.hash !== hash) fail('Fonte/consulta mudou; reinicie sem hash/offset.')
  if (offset > body.length) fail('offset fora da resposta.')
  const budget = Math.max(500, Math.min(50_000, lim.queryChars))
  const title = label.length > 120 ? label.slice(0, 119) + '…' : label
  const head = (end: number) => `${title} · hash ${hash} · caracteres ${offset}-${end} de ${body.length}${end < body.length ? ` · próximo offset ${end} (mesmos argumentos + hash)` : ' · fim'}\n${note}\n`
  let end = Math.min(body.length, offset + Math.max(1, budget - head(offset).length - 20))
  while (end > offset && head(end).length + end - offset > budget) end--
  if (end === offset && offset < body.length) fail('Cabeçalho excede queryChars; aumente o limite da consulta.')
  return head(end) + body.slice(offset, end)
}

function reference(c: Local, value: string): string {
  if (/^(?:user|uid|file):\/\//.test(value)) return '[referência externa não resolvida]'
  try {
    const candidate = /^(?:[a-z]:[\\/]|\/)/i.test(value) ? path.relative(c.cwd, value) : value.replace(/^res:\/\//, '')
    return 'res://' + localPath(c, candidate).rel
  } catch { return '[referência fora do escopo]' }
}

// O texto fonte permanece disponível pelas consultas paginadas; referências fora do escopo são explicitamente ocultadas.
function safeText(c: Local, text: string): string {
  const ref = (p: string) => {
    const suffix = /:\d+(?::\d+)?$/.exec(p)?.[0] ?? ''
    return reference(c, suffix ? p.slice(0, -suffix.length) : p) + suffix
  }
  return text.replace(/(?:res|user|file):\/\/[^\s"'<>),\]}]+/g, ref)
    .replace(/(?<![:/\w])(?:[a-z]:[\\/]|\/(?:[\w.-]+\/)+)[^\s"'<>),\]}]+/gi, ref)
    .replace(/(?<![\w:/\\])(?:[\w.-]+[/\\])+[\w.-]+\.(?:gd|cs|tscn|tres)(?::\d+(?::\d+)?)?/g, ref)
}

type Property = { name: string; value: string; line: number; endLine: number }
type Section = { kind: string; attrs: Record<string, string>; line: number; props: Property[]; node?: string }
function attributes(text: string) {
  const values: Record<string, string> = {}
  for (const match of text.matchAll(/(\w+)=("(?:\\.|[^"\\])*"|[^\s]+)/g)) {
    try { values[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2] } catch { values[match[1]] = match[2] }
  }
  return values
}

// Reconhece somente seções/propriedades declaradas. Arrays, dicionários e strings multilinha mantêm seus valores brutos.
function scene(text: string) {
  const lines = text.split(/\r?\n/), sections: Section[] = [], warnings: string[] = []
  let current: Section | undefined
  for (let i = 0; i < lines.length; i++) {
    const header = /^\[(gd_scene|gd_resource|ext_resource|sub_resource|node|resource|connection|editable)(?:\s+(.*))?\]\s*$/.exec(lines[i].trim())
    if (header) {
      current = { kind: header[1], attrs: attributes(header[2] ?? ''), line: i + 1, props: [] }
      if (current.kind === 'node') current.node = current.attrs.parent === undefined ? '.' : current.attrs.parent === '.' ? current.attrs.name : `${current.attrs.parent}/${current.attrs.name}`
      sections.push(current); continue
    }
    if (!lines[i].trim() || /^\s*;/.test(lines[i])) continue
    const prop = /^\s*([\w/.:+-]+)\s*=\s*(.*)$/.exec(lines[i])
    if (!current || !prop) { warnings.push(`Linha ${i + 1} não interpretada; consulte a fonte.`); continue }
    const first = i, chunks = [prop[2]], stack: string[] = []
    let quote = false, escaped = false, invalid = false
    const scan = (s: string) => {
      for (const ch of s) {
        if (escaped) { escaped = false; continue }
        if (quote && ch === '\\') { escaped = true; continue }
        if (ch === '"') { quote = !quote; continue }
        if (quote) continue
        if (ch === ';') break
        if ('([{'.includes(ch)) stack.push(ch)
        if (')]}'.includes(ch) && stack.pop() !== ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[ch]) invalid = true
      }
    }
    scan(prop[2])
    while ((quote || stack.length) && i + 1 < lines.length) { chunks.push(lines[++i]); scan(lines[i]) }
    if (quote || stack.length || invalid) warnings.push(`Valor não interpretado nas linhas ${first + 1}-${i + 1}; consulte a fonte.`)
    current.props.push({ name: prop[1], value: chunks.join('\n'), line: first + 1, endLine: i + 1 })
  }
  if (!sections.some(s => s.kind === 'gd_scene' || s.kind === 'gd_resource')) fail('Cabeçalho Godot textual não encontrado.')
  return { sections, warnings }
}

function sceneBody(c: Local, file: ReturnType<typeof source>, a: any) {
  if (!/\.(?:tscn|tres)$/i.test(file.rel)) fail('path deve ser .tscn ou .tres.')
  if (a.node !== undefined && a.resource !== undefined) fail('Selecione node ou resource.')
  const parsed = scene(file.text)
  const nodes = parsed.sections.filter(s => s.kind === 'node')
  const resources = parsed.sections.filter(s => s.kind === 'resource' || s.kind === 'sub_resource')
  let chosen = [...nodes, ...resources]
  if (a.node !== undefined) {
    const wanted = str(a.node, 'node')
    chosen = nodes.filter(s => wanted === '.' || s.node === wanted || s.node?.startsWith(wanted + '/'))
  }
  if (a.resource !== undefined) {
    const wanted = str(a.resource, 'resource')
    chosen = resources.filter(s => wanted === 'main' ? s.kind === 'resource' : s.attrs.id === wanted)
  }
  if (!chosen.length && (a.node !== undefined || a.resource !== undefined)) fail('Nó/recurso não declarado neste arquivo.')
  const refs = parsed.sections.filter(s => s.kind === 'ext_resource')
  const refLine = (s: Section) => `referência ${s.attrs.id ?? '?'} · ${s.attrs.type ?? '?'} · ${s.attrs.path ? reference(c, s.attrs.path) : '[UID sem caminho; não resolvido]'} · linha ${s.line}`
  const nameOf = (s: Section) => s.kind === 'node' ? `nó ${s.node} (${s.attrs.name}; ${s.attrs.type ?? 'instância/herdado'})` : `recurso ${s.kind === 'resource' ? 'main' : s.attrs.id}`
  const out = [`${nodes.length} nó(s), ${resources.length} recurso(s), ${refs.length} referência(s) declarados; ${chosen.length} selecionado(s).`]
  if (a.property !== undefined) {
    if (a.node === undefined && a.resource === undefined) fail('property exige node ou resource.')
    const wanted = str(a.property, 'property')
    // Uma propriedade de nó nunca inclui descendentes implicitamente.
    const exact = a.node !== undefined ? chosen.filter(s => s.node === a.node) : chosen
    const props = exact.flatMap(s => s.props.filter(p => p.name === wanted).map(p => `${nameOf(s)} · ${p.name} · linhas ${p.line}-${p.endLine}\n${safeText(c, p.value)}`))
    if (!props.length) fail('Propriedade não declarada; pode vir de herança/instância/default da engine.')
    out.push(...props)
  } else {
    for (const s of chosen) {
      const script = s.props.find(p => p.name === 'script')
      const instance = s.attrs.instance
      out.push(`${nameOf(s)} · linha ${s.line}${instance ? ` · instance ${safeText(c, instance)}` : ''}${script ? ` · script ${safeText(c, script.value)}` : ''}`)
      out.push(`propriedades (${s.props.length}): ${s.props.map(p => `${p.name}@${p.line}`).join(', ') || 'nenhuma'}`)
    }
  }
  const needed = a.node !== undefined || a.resource !== undefined ? new Set(chosen.flatMap(s => [...Object.values(s.attrs), ...s.props.map(p => p.value)].flatMap(value => [...value.matchAll(/ExtResource\("([^"\\]+)"\)/g)].map(m => m[1])))) : null
  const selectedNodes = new Set(chosen.map(s => s.node))
  const connections = parsed.sections.filter(s => s.kind === 'connection' && (a.node === undefined || selectedNodes.has(s.attrs.from) || selectedNodes.has(s.attrs.to)))
  out.push(...refs.filter(s => !needed || needed.has(s.attrs.id)).map(refLine), ...connections.map(s => `conexão ${s.attrs.from}.${s.attrs.signal} → ${s.attrs.to}.${s.attrs.method} · linha ${s.line}`), ...parsed.warnings)
  return out.join('\n')
}

export function callGodotTool(db: DatabaseSync, lim: ContextLimits, ctx: ToolCtx, organizerId: string, name: string, input: unknown): ToolResult {
  try {
    const c = context(db, ctx, organizerId)
    const a = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, any> : {}
    const def = GODOT_TOOLS.find(t => t.name === name)
    if (!def) fail('Ferramenta Godot desconhecida.')
    const allowed = Object.keys((def!.inputSchema as any).properties)
    if (Object.keys(a).some(k => !allowed.includes(k))) fail('Argumento não permitido; tarefa/organizador vêm da execução.')
    if (name === 'godot_project') {
      const project = godotProject(c.cwd, c.allow), body = safeText(c, JSON.stringify(project, null, 2)), hash = sha(body)
      return { text: page('Godot · projeto', hash, body, a, lim, 'Hash da consulta; versão declarada. Não verifica engine/templates; detalhes brutos: read_file_range.'), isError: false }
    }
    const file = source(c, a.path)
    if (name === 'godot_scene') {
      const body = sceneBody(c, file, a)
      return { text: page(`${file.rel} · ${file.lines} linhas · fonte ${file.hash.slice(0, 12)}`, sha(file.hash + body), body, a, lim, 'Declarações; herança/instâncias/defaults não resolvidos. Referências externas ocultadas. Detalhes: node/resource + property ou read_file_range.'), isError: false }
    }
    if (name === 'godot_diagnostics') {
      if (!/\.(?:log|txt)$/i.test(file.rel)) fail('path deve indicar um log textual .log ou .txt do Godot.')
      if (a.raw !== undefined && typeof a.raw !== 'boolean') fail('raw inválido.')
      if (a.raw && a.detail !== undefined) fail('Selecione raw ou detail.')
      const diag = godotDiagnostics(file.text)
      let body = `${diag.errorCount} erro(s), ${diag.warningCount} aviso(s), ${diag.items.length} diagnóstico(s) distintos em ${diag.totalLines} linhas. Ausência de diagnóstico reconhecido não prova sucesso.\n`
      if (a.raw) body = safeText(c, file.text)
      else if (a.detail !== undefined) {
        const i = num(a.detail, 'detail'), item = diag.items[i]
        if (!item) fail('Diagnóstico inexistente.')
        const message = item.file ? item.message.split(item.file).join(reference(c, item.file)) : item.message
        body += safeText(c, JSON.stringify({ index: i, ...item, message, file: item.file ? reference(c, item.file) : undefined }, null, 2))
      } else body += diag.items.map((item, i) => safeText(c, `${i} [${item.severity}] ${item.file ? item.message.split(item.file).join(reference(c, item.file)) : item.message} · repetições ${item.count}${item.file ? ` · ${reference(c, item.file)}${item.line ? ':' + item.line : ''}` : ''} · linha do log ${item.outputLines[0]}`)).join('\n')
      return { text: page(`${file.rel} · log local · fonte ${file.hash.slice(0, 12)}`, sha(file.hash + body), body, a, lim, 'Só mensagens reconhecidas; detail = índice, raw = log paginado (caminhos externos ocultados). Sem histórico do dashboard.'), isError: false }
    }
    return fail('Ferramenta Godot desconhecida.')
  } catch (error: any) { return { text: `Erro: ${String(error?.message ?? error).slice(0, 500)}`, isError: true } }
}

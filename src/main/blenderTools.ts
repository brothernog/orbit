// Consultas locais Blender: fatos compactos de .blend (binário) sem chamada de IA; o Blender roda em segundo plano, somente leitura.
import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { sha } from './artifacts.ts'
import { blenderDiagnostics, blenderProbe, inspectBlend, listBlendFiles, newerThan, readBlendHeader } from './blender.ts'
import { checkArgs, engineContext, fail, hideAbsolute, localPath, num, page, pageArgs, schema, source, str, type Local } from './engineTools.ts'
import type { ContextLimits } from './limits.ts'
import type { ToolDef, ToolResult } from './mcp.ts'
import type { ToolCtx } from './taskContext.ts'

const MODES = ['summary', 'object', 'materials', 'images', 'audit', 'libraries']
export const BLENDER_TOOLS: ToolDef[] = [
  { name: 'blender_project', description: 'Blender local: versão do executável e arquivos .blend (tamanho, versão do cabeçalho, compressão, backups). Não abre os arquivos.', inputSchema: schema(pageArgs) },
  { name: 'blender_scene', description: 'Fatos de um .blend: abre o Blender local em segundo plano com scripts embutidos desativados; nunca salva; cacheado. mode: summary (padrão), object (object=nome exato), materials, images, libraries, audit (antes de exportar: transformações, UV, texturas, skin/rig). Nos demais modos object = filtro glob de nomes.', inputSchema: schema({ path: { type: 'string' }, mode: { type: 'string', enum: MODES }, object: { type: 'string' }, scene: { type: 'string' }, ...pageArgs }, ['path']) },
  { name: 'blender_diagnostics', description: 'Agrupa tracebacks Python, erros e avisos de um log do Blender (.log/.txt no workspace). detail = índice; raw = log paginado.', inputSchema: schema({ path: { type: 'string' }, detail: { type: 'integer', minimum: 0 }, raw: { type: 'boolean' }, ...pageArgs }, ['path']) }
]
const INTERNAL = ['.git', '.worktrees', 'node_modules']
const kib = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`
const ident = (v: unknown, label: string) => { const s = str(v, label, 200); if (/[\x00-\x1f\x7f]/.test(s)) fail(`${label} inválido.`); return s }

async function project(c: Local, a: any, lim: ContextLimits) {
  let blender = ''
  let version: string | null = null
  try { version = (await blenderProbe(c.organizer.executable, c.cwd)).version; blender = `Blender ${version} (executável configurado: ${c.organizer.executable})` }
  catch (e: any) { blender = `Blender indisponível: ${String(e?.message ?? e).slice(0, 200)} blender_scene falhará até corrigir; o cabeçalho abaixo não depende dele.` }
  const list = listBlendFiles(c.cwd, c.allow, c.internal)
  const lines = [hideAbsolute(c, blender), `${list.files.length} arquivo(s) .blend${list.truncated ? ' (varredura limitada; há mais)' : ''} · backups .blend1/.blend@ ignorados: ${list.backups}`]
  for (const f of list.files) {
    let h: Awaited<ReturnType<typeof readBlendHeader>> = null
    try { h = await readBlendHeader(f.abs) } catch {}
    const v = h?.version ? `Blender ${h.version}` : h?.compressed ? 'versão desconhecida' : 'cabeçalho inválido'
    lines.push([f.rel, kib(f.size), v, h?.compressed, h?.pointer === 4 ? '32 bits' : '', h?.endian === 'big' ? 'big-endian' : '', f.backups ? `${f.backups} backup(s)` : '', version && newerThan(h?.version ?? null, version) ? `MAIS NOVO que o Blender ${version}: abrir pode falhar/perder dados` : ''].filter(Boolean).join(' · '))
  }
  if (!list.files.length) lines.push('Nenhum .blend no escopo autorizado.')
  const body = lines.join('\n')
  return page('Blender · projeto', sha(body), body, a, lim, 'Só metadados de arquivo. Próximo: blender_scene path=<arquivo> (summary; audit antes de exportar).')
}

async function scene(c: Local, a: any, lim: ContextLimits, signal?: AbortSignal) {
  const f = localPath(c, a.path)
  if (!/\.blend$/i.test(f.rel)) fail('path deve ser um arquivo .blend.')
  if (!fs.statSync(f.abs, { throwIfNoEntry: false })?.isFile()) fail('Arquivo .blend inexistente.')
  const mode = a.mode ?? 'summary'
  if (!MODES.includes(mode)) fail(`mode inválido; use ${MODES.join('|')}.`)
  const args = { mode, ...(a.object !== undefined && { object: ident(a.object, 'object') }), ...(a.scene !== undefined && { scene: ident(a.scene, 'scene') }) }
  if (mode === 'object' && !args.object) fail('mode=object exige object=<nome>.')
  if (mode !== 'summary' && mode !== 'audit' && args.scene) fail('scene só vale em summary/audit.')
  const probe = await blenderProbe(c.organizer.executable, c.cwd)
  const header = await readBlendHeader(f.abs).catch(() => null)
  const warn = newerThan(header?.version ?? null, probe.version) ? `ATENÇÃO: arquivo salvo no Blender ${header!.version}, mais novo que o local ${probe.version}; dados novos podem faltar.\n` : ''
  const r = await inspectBlend({ exe: probe.exe, version: probe.version, file: f.abs, root: c.cwd, args, signal })
  const body = warn + hideAbsolute(c, r.text)
  return page(`${f.rel} · ${mode} · Blender ${probe.version}${r.cached ? ' · cache' : ''}`, sha(r.key + body), body, a, lim, 'Somente leitura; t=malha base, ~t=estimado após modificadores. Detalhe: mode=object object=<nome>; filtro: object=<glob>.')
}

function diagnostics(c: Local, a: any, lim: ContextLimits) {
  const file = source(c, a.path)
  if (!/\.(?:log|txt)$/i.test(file.rel)) fail('path deve indicar um log textual .log ou .txt do Blender.')
  if (a.raw !== undefined && typeof a.raw !== 'boolean') fail('raw inválido.')
  if (a.raw && a.detail !== undefined) fail('Selecione raw ou detail.')
  const diag = blenderDiagnostics(file.text, { cwd: c.cwd })
  let body = `${diag.errorCount} erro(s), ${diag.warningCount} aviso(s), ${diag.items.length} diagnóstico(s) distintos em ${diag.totalLines} linhas. Ausência de diagnóstico reconhecido não prova sucesso.\n`
  if (a.raw) body = hideAbsolute(c, file.text)
  else if (a.detail !== undefined) {
    const i = num(a.detail, 'detail'), item = diag.items[i] ?? fail('Diagnóstico inexistente.')
    body += hideAbsolute(c, JSON.stringify({ index: i, ...item }, null, 2))
  } else body += diag.items.map((d, i) => hideAbsolute(c, `${i} [${d.severity}] ${d.message}${d.file ? ` · ${d.file}${d.line ? ':' + d.line : ''}` : ''} · repetições ${d.count} · linha do log ${d.outputLines[0]}`)).join('\n')
  return page(`${file.rel} · log Blender · fonte ${file.hash.slice(0, 12)}`, sha(file.hash + body), body, a, lim, 'Só mensagens reconhecidas; detail = índice, raw = log paginado (caminhos externos ocultados).')
}

export async function callBlenderTool(db: DatabaseSync, lim: ContextLimits, ctx: ToolCtx, organizerId: string, name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
  let c: Local | undefined
  try {
    c = engineContext(db, ctx, 'blender', organizerId, INTERNAL)
    const a = checkArgs(BLENDER_TOOLS, name, input)
    if (name === 'blender_project') return { text: await project(c, a, lim), isError: false }
    if (name === 'blender_scene') return { text: await scene(c, a, lim, signal), isError: false }
    return { text: diagnostics(c, a, lim), isError: false }
  } catch (error: any) {
    // Mensagens podem citar caminhos da máquina (executável, log do Blender): relativos se no workspace, ocultos se fora.
    const m = String(error?.message ?? error)
    return { text: `Erro: ${(c ? hideAbsolute(c, m) : m.replace(/(?<![\w.])(?:[a-z]:[\\/]|\/)[^\s"']+/gi, '[caminho]')).slice(0, 500)}`, isError: true }
  }
}

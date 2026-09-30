// Base comum das consultas MCP de engine (Godot, Unity, Blender): identidade da execução, caminho no escopo, fonte textual e paginação com hash.
// Nada aqui executa engine; cada módulo de engine decide o que ler e como resumir.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { sha } from './artifacts.ts'
import { engineOrganizer, ENGINE_LABELS, type EngineId } from './engines.ts'
import { inScope, safeJoin, samePath } from './guard.ts'
import type { ContextLimits } from './limits.ts'
import type { ToolCtx } from './taskContext.ts'

export const pageArgs = { offset: { type: 'integer', minimum: 0 }, hash: { type: 'string', description: 'Hash da resposta anterior ao continuar.' } }
export const schema = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
export const fail = (message: string): never => { throw new Error(message) }
export const str = (v: unknown, name: string, max = 1000) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail(`${name} inválido.`)
export const num = (v: unknown, name: string) => v == null ? 0 : Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : fail(`${name} inválido.`)
export const bool = (v: unknown, name: string) => v === undefined ? undefined : typeof v === 'boolean' ? v : fail(`${name} inválido.`)
const scopes = (values: string[]) => [...new Set(values.map(v => {
  const s = str(v, 'escopo').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.'
  if (/^(?:\/|[a-z]:)/i.test(s) || s.split('/').includes('..')) fail('Escopo inválido.')
  return s
}))].sort()

// internal: segmentos de caminho que a engine nunca expõe (caches, credenciais).
export type Local = { cwd: string; allow: (rel: string) => boolean; internal: string[]; organizer: { id: string; executable: string } }
export function engineContext(db: DatabaseSync, c: ToolCtx, engine: EngineId, organizerId: string, internal: string[]): Local {
  if (c.auth.taskId !== c.taskId || c.auth.recipient.logicalId !== c.lineage) fail('Identidade de execução incompatível.')
  const cwd = fs.realpathSync(c.cwd)
  if (!samePath(cwd, fs.realpathSync(c.auth.recipient.workspace))) fail('Workspace não autorizado.')
  const scope = scopes(c.scope)
  if (JSON.stringify(scope) !== JSON.stringify(scopes(c.auth.recipient.scope))) fail('Escopo não autorizado.')
  const task = db.prepare('SELECT game,worktree FROM tasks WHERE id=?').get(c.taskId) as { game: string; worktree: string | null } | undefined
  if (!task || !samePath(cwd, task.worktree || task.game)) fail('Workspace incompatível com a tarefa atual.')
  const organizer = task && engineOrganizer(db, task.game, engine)
  if (!organizer || organizer.id !== organizerId || !organizer.config.enabled) fail(`${ENGINE_LABELS[engine]} indisponível no organizador desta execução.`)
  return { cwd, allow: rel => inScope(rel, scope), internal, organizer: { id: organizer!.id, executable: organizer!.config.executable } }
}

export const relOf = (c: Local, abs: string) => path.relative(c.cwd, abs).split(path.sep).join('/')
export function localPath(c: Local, value: unknown, label = 'path'): { abs: string; rel: string } {
  const p = str(value, label)
  if (/^(?:[\\/]|[a-z]:|\w+:\/\/)/i.test(p) || p.split(/[\\/]/).includes('..')) fail('Caminho fora do workspace.')
  const abs = safeJoin(c.cwd, p), rel = relOf(c, abs)
  if (rel.split('/').some(s => c.internal.includes(s))) fail('Arquivo interno/credencial fora destas consultas.')
  if (!c.allow(rel)) fail('Arquivo fora do escopo autorizado.')
  return { abs, rel }
}

export const MAX_SOURCE = 4 * 1024 * 1024
export type Source = { abs: string; rel: string; text: string; hash: string; lines: number }
export function source(c: Local, value: unknown, max = MAX_SOURCE): Source {
  const f = localPath(c, value)
  const st = fs.statSync(f.abs)
  if (!st.isFile()) fail('Não é um arquivo.')
  // ponytail: leitura síncrona limitada; streaming se projetos reais exigirem arquivos maiores.
  if (st.size > max) fail(`Arquivo acima de ${Math.round(max / 1024 / 1024)} MiB; use leitura por intervalo ou uma fonte menor.`)
  const bytes = fs.readFileSync(f.abs)
  if (bytes.includes(0)) fail('Arquivo binário; esta consulta lê somente texto.')
  const text = bytes.toString('utf8').replace(/^﻿/, '')
  return { ...f, text, hash: sha(bytes), lines: text.split(/\r?\n/).length }
}

// Página com orçamento queryChars: o cabeçalho diz onde continuar; hash impede juntar páginas de fontes diferentes.
export function page(label: string, hash: string, body: string, args: any, lim: ContextLimits, note: string) {
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

// Caminho absoluto/relativo citado por um log ou metadado: relativo ao workspace quando permitido; caso contrário, ocultado.
export function workspaceRef(c: Local, value: string): string {
  try {
    const candidate = /^(?:[a-z]:[\\/]|\/)/i.test(value) ? path.relative(c.cwd, value) : value
    return localPath(c, candidate).rel
  } catch { return '[caminho fora do escopo]' }
}
// Oculta caminhos absolutos fora do workspace (usuário, máquina) em textos livres; os de dentro viram relativos.
export function hideAbsolute(c: Local, text: string): string {
  return text.replace(/(?<![:/\w])(?:[a-z]:[\\/]|\/(?:[\w .-]+\/)+)[^\s"'<>|),\]}]*/gi, m => {
    const suffix = /(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))$/.exec(m)?.[0] ?? ''
    return workspaceRef(c, suffix ? m.slice(0, -suffix.length) : m) + suffix
  })
}

// Argumentos fora do schema são recusados: tarefa/organizador/engine vêm da execução, nunca do agente.
export function checkArgs(tools: { name: string; inputSchema: object }[], name: string, input: unknown): Record<string, any> {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, any> : {}
  const def = tools.find(t => t.name === name) ?? fail('Ferramenta desconhecida.')
  const allowed = Object.keys((def.inputSchema as any).properties)
  if (Object.keys(a).some(k => !allowed.includes(k))) fail('Argumento não permitido; tarefa/organizador vêm da execução.')
  return a
}

// Observabilidade efemera: so campos expostos pelas CLIs, nunca raciocinio cifrado ou cursores inferidos.
export type Activity = {
  kind: 'read' | 'edit' | 'image' | 'thinking' | 'tool' | 'message'
  tool?: string
  path?: string // caminho do provedor; quem publica valida contra o projeto
  line?: number
  endLine?: number
  position?: 'reported' | 'diff'
  added?: number
  removed?: number
  summary?: string
  fullText?: string // interno: texto completo para leitura sob demanda; remover antes de publicar por IPC
  truncated?: boolean
  ref?: string
  direction?: 'sent' | 'received'
  title?: string
  agent?: string // id nativo do subagente, somente para observabilidade
}

export const MAX_ACTIVITY_TEXT = 16_000
const MAX_PATCH = 1_000_000
const string = (v: unknown) => typeof v === 'string' && v.length > 0 ? v : undefined
const line = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
const image = (p: string) => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(p)
export const activityText = (kind: 'thinking' | 'message', text: unknown, extra: Partial<Activity> = {}): Activity[] =>
  typeof text === 'string' && text ? [{ ...extra, kind, summary: text.slice(0, MAX_ACTIVITY_TEXT), ...(text.length > MAX_ACTIVITY_TEXT ? { truncated: true, fullText: text } : {}) }] : []

// Ferramentas com contrato conhecido. Nomes/padroes de shell e diretorios de busca nao viram arquivos.
export function toolActivity(provider: string, tool: string, raw: any, ref?: string): Activity[] {
  let input = raw
  if (typeof input === 'string' && input.length <= MAX_PATCH) { try { input = JSON.parse(input) } catch { return [] } }
  const name = tool.split('__').pop() ?? tool
  const read = name === 'read_file_range' || (provider === 'claude' && name === 'Read') || (provider === 'gemini' && name === 'read_file') || (provider === 'opencode' && name === 'read')
  const edit = (provider === 'claude' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) || (provider === 'gemini' && ['replace', 'write_file'].includes(name)) || (provider === 'opencode' && ['edit', 'write', 'multiedit'].includes(name))
  const view = ['view_image', 'open_image'].includes(name)
  if (!read && !edit && !view) return []
  const p = string(input?.file_path ?? input?.filePath ?? input?.notebook_path ?? input?.path)
  if (!p) return []
  const a: Activity = { kind: view || (read && image(p)) ? 'image' : edit ? 'edit' : 'read', tool, path: p, ...(ref ? { ref } : {}) }
  if (read && a.kind === 'read') {
    const start = line(name === 'read_file_range' ? input?.startLine : provider === 'gemini' ? input?.start_line : input?.offset)
    const end = line(name === 'read_file_range' ? input?.endLine : provider === 'gemini' ? input?.end_line : start && line(input?.limit) ? start + input.limit - 1 : undefined)
    if (start) { a.line = start; a.position = 'reported' }
    if (end && (!start || end >= start)) a.endLine = end
  }
  return [a]
}

// Apenas hunks numerados fornecem posicao; essa posicao descreve o diff, nao um cursor do agente.
export function patchActivity(p: string, patch: unknown, extra: Partial<Activity> = {}): Activity {
  const a: Activity = { ...extra, kind: 'edit', path: p }
  let hunks: { newStart: number; lines: string[] }[] = []
  if (Array.isArray(patch)) hunks = patch.slice(0, 1000).filter(h => h && count(h.newStart) !== undefined && Array.isArray(h.lines))
  else if (typeof patch === 'string' && patch.length <= MAX_PATCH) {
    for (const row of patch.split(/\r?\n/)) {
      const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
      if (head) hunks.push({ newStart: Number(head[1]), lines: [] })
      else if (hunks.length) hunks[hunks.length - 1].lines.push(row)
    }
  }
  let added = 0, removed = 0, first: number | undefined, last: number | undefined, processed = 0
  for (const h of hunks) {
    let cursor = Math.max(1, h.newStart)
    for (const row of h.lines) {
      if (typeof row !== 'string') continue
      processed += row.length
      if (processed > MAX_PATCH) return a // diff grande/incompleto: nao publica contagens parciais
      if (row[0] === '+' || row[0] === '-') {
        first = first === undefined ? cursor : Math.min(first, cursor)
        last = last === undefined ? cursor : Math.max(last, cursor)
        if (row[0] === '+') { added++; cursor++ } else removed++
      } else if (row[0] === ' ') cursor++
    }
  }
  if (first !== undefined) Object.assign(a, { line: first, endLine: last, position: 'diff', added, removed })
  return a
}

export function claudeResultActivity(result: any, ref?: string): Activity[] {
  const extra = ref ? { ref } : {}
  if (Array.isArray(result)) return result.slice(0, 100).flatMap(r => claudeResultActivity(r, ref))
  if (!result || result.staged === true) return []
  const p = string(result.filePath ?? result.file?.filePath)
  if (!p) return []
  if (Array.isArray(result.structuredPatch)) return [patchActivity(p, result.structuredPatch, extra)]
  if (result.type === 'text' && result.file) {
    const start = line(result.file.startLine), size = line(result.file.numLines)
    return [{ kind: 'read', path: p, ...extra, ...(start ? { line: start, position: 'reported' as const, ...(size ? { endLine: start + size - 1 } : {}) } : {}) }]
  }
  return []
}

export function opencodeActivity(part: any): Activity[] {
  const tool = string(part?.tool)
  if (!tool) return []
  const ref = string(part.callID ?? part.id)
  const state = part.state
  if (state?.status !== 'completed') return toolActivity('opencode', tool, state?.input, ref)
  const meta = state.metadata
  const files = Array.isArray(meta?.files) ? meta.files.slice(0, 100) : meta?.filediff ? [meta.filediff] : []
  if (files.length) return files.flatMap((f: any) => {
    const p = string(f?.movePath ?? f?.filePath ?? f?.file)
    if (!p) return []
    const a = patchActivity(p, f.patch, { tool, ...(ref ? { ref } : {}) })
    const added = count(f.additions), removed = count(f.deletions)
    if (added !== undefined) a.added = added
    if (removed !== undefined) a.removed = removed
    return [a]
  })
  const a = toolActivity('opencode', tool, state?.input, ref)
  if (a[0]?.kind === 'edit' && typeof meta?.diff === 'string') return [patchActivity(a[0].path!, meta.diff, a[0])]
  if (a[0]?.kind === 'read' && meta?.display?.type === 'file') {
    const start = line(meta.display.lineStart), end = line(meta.display.lineEnd)
    if (start) Object.assign(a[0], { line: start, position: 'reported', ...(end && end >= start ? { endLine: end } : {}) })
  }
  return a
}

export function codexMessages(item: any, phase: string): Activity[] {
  const out: Activity[] = []
  if (phase === 'item.started' && ['spawn_agent', 'send_input'].includes(item?.tool)) {
    for (const id of Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.slice(0, 100) : []) {
      if (typeof id !== 'string' || !id) continue
      out.push(...activityText('message', item.prompt, { tool: item.tool, agent: id.slice(0, 200), direction: 'sent', title: 'Mensagem ao subagente CLI', ...(string(item.id) ? { ref: `${item.id}:sent:${id}` } : {}) }))
    }
  }
  if (phase === 'item.completed' && item?.status === 'completed' && item.agents_states && typeof item.agents_states === 'object') {
    for (const [id, state] of Object.entries(item.agents_states).slice(0, 100)) {
      out.push(...activityText('message', (state as any)?.message, { tool: item.tool, agent: id.slice(0, 200), direction: 'received', title: 'Mensagem do subagente CLI', ...(string(item.id) ? { ref: `${item.id}:received:${id}` } : {}) }))
    }
  }
  return out
}

// Estado local por execucao, nunca compartilhado por agentes concorrentes. Partial messages nao contam ferramentas.
export function activityStream() {
  const streams = new Map<string, { id: string; blocks: Map<number, { text: string; type: string }> }>()
  const completed = new Set<string>()
  return {
    observe(raw: any): Activity[] {
      if (raw?.type !== 'stream_event') return []
      const ev = raw.event, parent = string(raw.parent_tool_use_id) ?? ''
      if (ev?.type === 'message_start') {
        if (streams.size >= 100) streams.delete(streams.keys().next().value!)
        streams.set(parent, { id: string(ev.message?.id) ?? string(raw.uuid) ?? parent, blocks: new Map() })
        return []
      }
      if (ev?.type === 'message_stop') { streams.delete(parent); return [] }
      const stream = streams.get(parent)
      if (!stream || !Number.isSafeInteger(ev?.index)) return []
      if (ev.type === 'content_block_start') {
        const c = ev.content_block
        if (stream.blocks.size < 100 && (c?.type === 'thinking' || (parent && c?.type === 'text'))) stream.blocks.set(ev.index, { text: '', type: c.type })
      }
      const block = stream.blocks.get(ev.index)
      if (!block) return []
      const text = ev.type === 'content_block_start' ? (ev.content_block?.thinking ?? ev.content_block?.text) : ev.delta?.type === 'thinking_delta' ? ev.delta.thinking : parent && ev.delta?.type === 'text_delta' ? ev.delta.text : undefined
      if (typeof text !== 'string' || !text) return []
      block.text += text
      const ref = `${stream.id}:${ev.index}`
      if (completed.size >= 1000) completed.delete(completed.values().next().value!)
      completed.add(ref)
      return activityText(block.type === 'thinking' ? 'thinking' : 'message', block.text, { ref, ...(parent ? { title: 'Subagente CLI', direction: 'received', agent: parent.slice(0, 200) } : {}) })
    },
    seen(ref?: string) { return !!ref && completed.has(ref) }
  }
}

// Servidor MCP local (Streamable HTTP, respostas JSON, sem SSE) que expoe ferramentas aos agentes.
// So escuta em 127.0.0.1, exige um token por execucao (Authorization: Bearer) e confere o Host (anti DNS rebinding).
// As ferramentas anunciadas dependem do papel do token (pai/filho): `tools(ctx)`. Sem dependencia de 'electron'.
import crypto from 'node:crypto'
import http from 'node:http'

export type ToolDef = { name: string; description: string; inputSchema: object }
export type ToolResult = { text: string; isError: boolean }
export type McpOptions<C> = {
  tools: (ctx: C) => ToolDef[] // so o que o papel do token pode usar
  authorize: (token: string) => C | null // token -> contexto da execucao que o recebeu (null = invalido/expirado)
  call: (ctx: C, name: string, args: unknown, signal: AbortSignal) => Promise<ToolResult> // signal aborta se o cliente desistir
}

export const newToken = () => crypto.randomBytes(24).toString('hex')
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 256 * 1024

export function startMcpServer<C>(o: McpOptions<C>): Promise<{ port: number; url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body?: object) => {
      res.writeHead(code, body ? { 'content-type': 'application/json' } : {})
      res.end(body ? JSON.stringify(body) : undefined)
    }
    const port = (server.address() as any)?.port
    const host = String(req.headers.host ?? '')
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'host nao permitido' })
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))
    const ctx = m ? o.authorize(m[1]) : null
    if (!ctx) return send(401, { error: 'token invalido ou expirado' })
    if (req.url !== '/mcp') return send(404)
    if (req.method !== 'POST') return send(405) // sem fluxo de servidor->cliente (SSE); clientes MCP toleram 405
    let raw = ''
    let big = false
    req.on('data', d => { raw += d; if (raw.length > MAX_BODY) { big = true; req.destroy() } })
    await new Promise(r => req.on('end', r).on('close', r))
    if (big) return
    let msg: any
    try { msg = JSON.parse(raw) } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalido' } }) }
    const reply = (result: object) => send(200, { jsonrpc: '2.0', id: msg.id, result })
    const fail = (code: number, message: string) => send(200, { jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } })
    if (msg.id === undefined) return send(202) // notificacoes (ex.: notifications/initialized)
    switch (msg.method) {
      case 'initialize': {
        const v = msg.params?.protocolVersion
        return reply({ protocolVersion: VERSIONS.includes(v) ? v : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'gaming-planning-dashboard', version: '1.0.0' } })
      }
      case 'ping': return reply({})
      case 'tools/list': return reply({ tools: o.tools(ctx) })
      case 'tools/call': {
        const name = String(msg.params?.name)
        if (!o.tools(ctx).some(t => t.name === name)) return fail(-32602, `ferramenta desconhecida: ${name.slice(0, 60)}`)
        const ac = new AbortController()
        res.on('close', () => { if (!res.writableFinished) ac.abort() }) // cliente desistiu (timeout/cancelamento)
        try {
          const r = await o.call(ctx, name, msg.params?.arguments, ac.signal)
          return reply({ content: [{ type: 'text', text: r.text }], isError: r.isError })
        } catch (e: any) {
          return reply({ content: [{ type: 'text', text: `Erro: ${String(e?.message ?? e).slice(0, 500)}` }], isError: true })
        }
      }
      default: return fail(-32601, 'metodo nao suportado')
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      resolve({ port, url: `http://127.0.0.1:${port}/mcp`, close: () => { server.close(); server.closeAllConnections() } })
    })
  })
}

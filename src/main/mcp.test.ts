import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { newToken, startMcpServer, type ToolDef } from './mcp.ts'

const TOOL: ToolDef = { name: 'delegate_to_agent', description: 'x', inputSchema: { type: 'object', properties: {} } }
const READ: ToolDef = { name: 'read_task_context', description: 'y', inputSchema: { type: 'object', properties: {} } }

async function server(call?: (ctx: string, args: unknown, signal: AbortSignal) => Promise<{ text: string; isError: boolean }>) {
  const valid = new Map([['tok-a', 'ctx-a']])
  const fn = call ?? (async (ctx, args) => ({ text: `${ctx}:${JSON.stringify(args)}`, isError: false }))
  // ctx-filho enxerga so a ferramenta de leitura; ctx-a enxerga as duas (papel define o que e anunciado e chamavel)
  const s = await startMcpServer<string>({
    tools: ctx => (ctx === 'ctx-filho' ? [READ] : [TOOL, READ]), authorize: t => valid.get(t) ?? null, call: (ctx, _name, args, signal) => fn(ctx, args, signal)
  })
  const rpc = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer tok-a' }) =>
    fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { s, rpc, valid }
}

test('handshake MCP, lista de ferramentas e chamada com o contexto do token', async () => {
  const { s, rpc } = await server()
  try {
    const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })).json() as any
    assert.equal(init.result.protocolVersion, '2025-03-26') // negocia a versao pedida quando suportada
    assert.deepEqual(init.result.capabilities, { tools: {} })
    assert.equal((await (await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json() as any).result.protocolVersion, '2025-06-18')
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202) // notificacao: sem corpo
    const list = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json() as any
    assert.deepEqual(list.result.tools.map((t: ToolDef) => t.name), ['delegate_to_agent', 'read_task_context'])
    const call = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delegate_to_agent', arguments: { a: 1 } } })).json() as any
    assert.deepEqual(call.result, { content: [{ type: 'text', text: 'ctx-a:{"a":1}' }], isError: false })
    assert.equal(((await (await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' })).json()) as any).result !== undefined, true)
  } finally { s.close() }
})

test('sem token valido, host errado, metodo/rota/JSON invalidos e ferramenta desconhecida sao recusados', async () => {
  const { s, rpc, valid } = await server()
  try {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {})).status, 401)
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer outro' })).status, 401)
    valid.delete('tok-a') // token expirado (execucao do pai terminou)
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401)
    valid.set('tok-a', 'ctx-a')
    assert.equal((await fetch(s.url, { headers: { authorization: 'Bearer tok-a' } })).status, 405) // GET (SSE) nao suportado
    assert.equal((await fetch(s.url.replace('/mcp', '/outra'), { method: 'POST', headers: { authorization: 'Bearer tok-a' }, body: '{}' })).status, 404)
    assert.equal((await rpc('{nao e json')).status, 400)
    const unk = await (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'apagar_tudo', arguments: {} } })).json() as any
    assert.match(unk.error.message, /ferramenta desconhecida/)
    assert.equal(((await (await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).json()) as any).error.code, -32601)
    // Host adulterado (DNS rebinding): requisicao crua com outro Host
    const port = new URL(s.url).port
    const status = await new Promise<number>(resolve => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: { host: 'evil.example', authorization: 'Bearer tok-a' } }, res => resolve(res.statusCode!))
      r.end('{}')
    })
    assert.equal(status, 403)
  } finally { s.close() }
})

test('erro da ferramenta vira resultado isError; cliente que desiste aborta a chamada', async () => {
  let aborted = false
  const { s, rpc } = await server(async (_c, args: any, signal) => {
    if (args?.boom) throw new Error('falhou por dentro')
    await new Promise(r => { signal.addEventListener('abort', () => { aborted = true; r(null) }); setTimeout(r, 3000) })
    return { text: 'tarde demais', isError: false }
  })
  try {
    const boom = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate_to_agent', arguments: { boom: true } } })).json() as any
    assert.equal(boom.result.isError, true)
    assert.match(boom.result.content[0].text, /falhou por dentro/)
    const ac = new AbortController()
    const p = fetch(s.url, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_to_agent', arguments: {} } }) }).catch(() => null)
    await new Promise(r => setTimeout(r, 300))
    ac.abort() // o cliente MCP cancelou/estourou o timeout
    await p
    for (let i = 0; i < 20 && !aborted; i++) await new Promise(r => setTimeout(r, 100))
    assert.equal(aborted, true)
  } finally { s.close() }
})

test('ferramentas anunciadas e chamaveis dependem do papel do token (filho nao ganha delegar)', async () => {
  const { s, rpc, valid } = await server()
  valid.set('tok-filho', 'ctx-filho')
  const child = { authorization: 'Bearer tok-filho' }
  try {
    const list = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, child)).json() as any
    assert.deepEqual(list.result.tools.map((t: ToolDef) => t.name), ['read_task_context'])
    const denied = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_to_agent', arguments: {} } }, child)).json() as any
    assert.match(denied.error.message, /ferramenta desconhecida/) // nao basta conhecer o nome
    const ok = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_task_context', arguments: { q: 1 } } }, child)).json() as any
    assert.equal(ok.result.content[0].text, 'ctx-filho:{"q":1}')
  } finally { s.close() }
})

test('tokens sao aleatorios e longos', () => {
  const a = newToken(), b = newToken()
  assert.notEqual(a, b)
  assert.match(a, /^[0-9a-f]{48}$/)
})

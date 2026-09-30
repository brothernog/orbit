// CLI falsa para o E2E: registra argv/cwd e responde no formato do codex ou do opencode.
// Tambem simula o app-server do codex (catalogo) e os catalogos do opencode, sem nenhuma chamada real.
const fs = require('fs')
const path = require('path')
const kind = process.argv[2] // codex | opencode
const argv = process.argv.slice(3)

if (kind === 'codex' && argv[0] === 'app-server') {
  // JSON-RPC por linhas: initialize, model/list paginado (2 paginas; um modelo oculto).
  const model = (m, def, efforts, hidden = false) => ({ id: m, model: m, displayName: m.toUpperCase(), hidden, isDefault: false, defaultReasoningEffort: def, supportedReasoningEfforts: efforts.map(e => ({ reasoningEffort: e })) })
  const pages = { first: { data: [model('gpt-6-luna', 'medium', ['low', 'medium', 'high']), model('modelo-oculto', 'low', ['low'], true)], nextCursor: 'p2' }, p2: { data: [model('gpt-5.5', 'medium', ['low', 'medium'])], nextCursor: null } }
  require('readline').createInterface({ input: process.stdin }).on('line', l => {
    const m = JSON.parse(l)
    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: 'fake', codexHome: '/x', platformFamily: 'windows', platformOs: 'windows' } }) + '\n')
    else if (m.method === 'model/list') process.stdout.write(JSON.stringify({ id: m.id, result: pages[m.params?.cursor ?? 'first'] }) + '\n')
  })
  process.stdin.on('end', () => process.exit(0))
} else if (kind === 'opencode' && argv[0] === 'auth') {
  console.log('┌  Credentials ~\\.local\\share\\opencode\\auth.json\n│\n●  DeepSeek api\n│\n└  1 credentials')
} else if (kind === 'opencode' && argv[0] === 'models') {
  const p = argv[1]
  if (p === 'deepseek') console.log('deepseek/deepseek-flash\n' + JSON.stringify({ id: 'deepseek-flash', name: 'DeepSeek Flash', limit: { context: 1000000, output: 1 }, variants: { low: {}, high: {}, max: {} } }, null, 2))
  if (p === 'opencode') console.log('opencode/big-pickle\n' + JSON.stringify({ id: 'big-pickle', name: 'Big Pickle', limit: { context: 128000, output: 1 } }, null, 2))
} else if (argv.includes('--help') || argv.includes('--version')) {
  fs.appendFileSync(process.env.E2E_LOG, JSON.stringify({ kind, argv, cwd: process.cwd(), input: '' }) + '\n')
  console.log(argv.includes('--version') ? `fake-${kind} 0.0.1` : 'usage')
} else {
  let input = ''
  process.stdin.on('data', d => (input += d))
  process.stdin.on('end', async () => {
    fs.appendFileSync(process.env.E2E_LOG, JSON.stringify({ kind, argv, cwd: process.cwd(), input, env: { ocConfig: process.env.OPENCODE_CONFIG_CONTENT ?? null, hasToken: !!process.env.DASHBOARD_MCP_TOKEN } }) + '\n')
    const out = o => process.stdout.write(JSON.stringify(o) + '\n')
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    // Filho de delegacao: a ordem esta na secao "Ordem direta:" (o final da entrada tem o pacote aprovado e o id). Chat: ultimo paragrafo.
    const direct = /Ordem direta:\n([\s\S]*?)(?:\n\n|$)/.exec(input)
    const last = direct ? direct[1] : input.split('\n\n').pop()
    const ri = argv.indexOf('resume')
    const sid = kind === 'codex' ? (ri >= 0 ? argv[ri + 1] : 'fake-codex-thread') : argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : 'ses_fakeopencode'
    const say = t => kind === 'codex' ? out({ type: 'item.completed', item: { type: 'agent_message', text: t } }) : out({ type: 'text', sessionID: sid, part: { text: t } })
    if (kind === 'codex') out({ type: 'thread.started', thread_id: sid })
    await sleep(200)
    if (!last.startsWith('DELEGAR:') && last.includes('FALHA')) {
      if (kind === 'codex') out({ type: 'turn.failed', error: { message: 'falha simulada do provedor' } })
      else out({ type: 'error', error: { name: 'UnknownError', data: { message: 'falha simulada do provedor' } } })
      process.exit(1)
    }
    if (!last.startsWith('DELEGAR:') && last.includes('TRAVAR')) {
      const kid = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
      fs.writeFileSync(process.env.E2E_PIDS, `${process.pid},${kid.pid}`)
      say('texto parcial antes de travar')
      setInterval(() => {}, 1000)
      return
    }
    if (kind === 'codex' && last.startsWith('XSS')) {
      say('Resposta [link seguro](https://example.com) e [perigoso](javascript:window.__pwn=1) e [arquivo](file:///C:/Windows/System32/calc.exe)\n\n<script>window.__pwn=2</script><img src=x onerror="window.__pwn=3"><svg onload="window.__pwn=4"></svg><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name=a></form><a href="mailto:a@b.co" onclick="window.__pwn=5">email</a>')
    } else if (kind === 'codex' && last.startsWith('MCPCALLS:')) {
      // Papel de AGENTE PAI chamando ferramentas MCP arbitrarias (ex.: read_task_skill) e reportando a lista de ferramentas anunciadas.
      const url = argv.find(a => a.startsWith('mcp_servers.dashboard.url=')).slice('mcp_servers.dashboard.url='.length)
      let id = 0
      const rpc = (method, params) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.DASHBOARD_MCP_TOKEN }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }).then(r => r.json())
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-parent', version: '0' } })
      const outs = ['TOOLS:' + (await rpc('tools/list', {})).result.tools.map(t => t.name).join(',')]
      for (const spec of JSON.parse(last.slice('MCPCALLS:'.length))) {
        const r = await rpc('tools/call', { name: spec.name, arguments: spec.arguments })
        outs.push(r.result ? (r.result.isError ? '[ERRO] ' : '') + r.result.content[0].text : '[ERRO-RPC] ' + JSON.stringify(r.error))
      }
      say('mcp:\n\n' + outs.join('\n\n---\n\n'))
    } else if (kind === 'codex' && last.startsWith('DELEGAR:')) {
      // Papel de AGENTE PAI: cliente MCP que chama a ferramenta de delegacao do dashboard (como faria o modelo).
      const url = argv.find(a => a.startsWith('mcp_servers.dashboard.url=')).slice('mcp_servers.dashboard.url='.length)
      const token = process.env.DASHBOARD_MCP_TOKEN
      let id = 0
      const rpc = (method, params) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (process.env.E2E_BAD_TOKEN || token) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }).then(r => r.json())
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-parent', version: '0' } })
      await rpc('tools/list', {})
      const outs = []
      for (const spec of JSON.parse(last.slice('DELEGAR:'.length))) {
        const r = await rpc('tools/call', { name: 'delegate_to_agent', arguments: spec })
        outs.push((r.result.isError ? '[ERRO] ' : '') + r.result.content[0].text)
      }
      say('resultado das delegacoes:\n\n' + outs.join('\n\n---\n\n'))
    } else {
      // Papel de AGENTE FILHO: ESCREVER:<arquivo> simula edicao (um arquivo pedido e outro fora do escopo).
      const w = /ESCREVER:(\S+)/.exec(last)
      if (w) {
        fs.mkdirSync(path.join(process.cwd(), path.dirname(w[1])), { recursive: true })
        fs.writeFileSync(path.join(process.cwd(), w[1]), 'editado')
        fs.writeFileSync(path.join(process.cwd(), 'fora-do-escopo.txt'), 'x')
      }
      const tail = last.slice(0, 100)
      if (kind === 'opencode' && /^SKILLCHILD/.test(last)) {
        // Papel de AGENTE FILHO com as ferramentas MCP de contexto (config inline do opencode): lista as ferramentas e tenta carregar as skills.
        const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).mcp.dashboard
        let id = 0
        const rpc = (method, params) => fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: cfg.headers.Authorization }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }).then(r => r.json())
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-child', version: '0' } })
        const names = (await rpc('tools/list', {})).result.tools.map(t => t.name)
        const skill = async name => { const r = await rpc('tools/call', { name: 'read_task_skill', arguments: { name } }); return r.result ? (r.result.isError ? '[ERRO] ' : '') + r.result.content[0].text.slice(0, 160).replace(/\n/g, ' ') : '[ERRO-RPC] ' + JSON.stringify(r.error) }
        say(`filho: ferramentas=${names.join(',')}\nmemoria: ${await skill('task-memory')}\ndelegacao: ${await skill('task-delegation')}`)
      } else
      say(`eco(${kind}): ${tail}`)
    }
    await sleep(200)
    if (kind === 'codex') {
      // Como o codex real: a sessao fica num rollout com eventos token_count (contexto da ultima chamada + janela).
      const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '28')
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, `rollout-2026-09-28T10-00-00-${sid}.jsonl`), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 5000, reasoning_output_tokens: 1000 }, model_context_window: 272000 } } }) + '\n')
      out({ type: 'turn.completed', usage: { input_tokens: 5000, output_tokens: 300 } })
    } else out({ type: 'step_finish', sessionID: sid, part: { reason: 'stop', tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 500, write: 0 } } } })
  })
}

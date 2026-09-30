// Publicacao pela API oficial do LinkedIn (produtos self-service "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect"
// no app de desenvolvedor do proprio usuario). So texto no perfil pessoal; conexoes e mensagens nao existem na API.
// OAuth pelo navegador padrao com retorno num servidor local de uso unico. Sem dependencia de 'electron' (o segredo e cifrado em index.ts).
import http from 'node:http'
import { fail } from './guard.ts'

export const REDIRECT_PORT = 47821
export const REDIRECT = `http://localhost:${REDIRECT_PORT}/callback`
const SCOPES = 'openid profile w_member_social'
type Fetch = typeof fetch

export const authUrl = (clientId: string, state: string) =>
  `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state, scope: SCOPES })}`

// Espera o LinkedIn devolver o navegador para REDIRECT com o `state` desta tentativa; qualquer outra coisa e recusada.
export function waitForCode(state: string, timeoutMs = 5 * 60_000, port = REDIRECT_PORT): { done: Promise<string>; close: () => void } {
  let close = () => {}
  const done = new Promise<string>((resolve, reject) => {
    const page = (res: http.ServerResponse, ok: boolean, msg: string) => {
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset="utf-8"><title>LinkedIn</title><body style="font:16px system-ui;background:#0a0d18;color:#e6ebf2;display:grid;place-items:center;height:100vh;margin:0"><p>${msg}</p>`)
    }
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', REDIRECT)
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return }
      if (u.searchParams.get('state') !== state) return page(res, false, 'Pedido de login desconhecido. Volte para a dashboard e tente de novo.')
      const err = u.searchParams.get('error_description') ?? u.searchParams.get('error')
      const code = u.searchParams.get('code')
      page(res, !!code, code ? 'Conectado. Pode fechar esta aba e voltar para a dashboard.' : `O LinkedIn recusou: ${(err ?? 'sem codigo').replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`)}`)
      finish(code ? null : new Error(`O LinkedIn recusou a autorizacao: ${err ?? 'sem codigo'}.`), code ?? '')
    })
    const timer = setTimeout(() => finish(new Error('Tempo esgotado: a autorizacao no navegador nao foi concluida em 5 minutos.')), timeoutMs)
    const finish = (e: Error | null, code = '') => { clearTimeout(timer); server.close(); e ? reject(e) : resolve(code) }
    close = () => finish(new Error('Conexao cancelada.'))
    server.on('error', (e: any) => finish(new Error(e?.code === 'EADDRINUSE' ? `A porta ${port} esta ocupada; feche o que estiver usando e tente de novo.` : String(e?.message ?? e))))
    server.listen(port, '127.0.0.1')
  })
  return { done, close: () => close() }
}

const must = async (r: Response, what: string): Promise<Response> => {
  if (r.ok) return r
  const body = (await r.text().catch(() => '')).slice(0, 300)
  return fail(`${what} falhou (${r.status})${r.status === 401 ? ': acesso expirado ou revogado, conecte de novo' : ''}. ${body}`)
}

export async function exchange(f: Fetch, o: { clientId: string; clientSecret: string; code: string }, now = Date.now()) {
  const r = await must(await f('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: o.code, redirect_uri: REDIRECT, client_id: o.clientId, client_secret: o.clientSecret }),
  }), 'Troca do codigo pelo acesso')
  const t = await r.json() as any
  if (!t.access_token) fail('O LinkedIn nao devolveu o acesso.')
  const me = await (await must(await f('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${t.access_token}` } }), 'Leitura do perfil')).json() as any
  if (!me.sub) fail('O LinkedIn nao informou o id do perfil (confira se o produto OpenID Connect esta ativo no app).')
  return { token: String(t.access_token), expiresAt: now + Number(t.expires_in ?? 0) * 1000, sub: String(me.sub), name: String(me.name ?? '') }
}

// A API de posts pede uma versao mensal ativa (cada uma vale ~1 ano). ponytail: usa a de 2 meses atras; se o LinkedIn mudar a politica, fixe aqui.
export const apiVersion = (now = new Date()) => { const d = new Date(now.getFullYear(), now.getMonth() - 2, 1); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}` }

// O campo do post usa o formato "little text": caracteres reservados precisam de escape, senao o post e recusado ou cortado.
// #palavra vira hashtag clicavel.
const RESERVED = /[\\|{}@[\]()<>#*_~]/g
const esc = (s: string) => s.replace(RESERVED, c => `\\${c}`)
export const littleText = (t: string) => t.split(/(#[\p{L}\p{N}_]+)/u).map((p, i) => (i % 2 ? `{hashtag|\\#|${esc(p.slice(1))}}` : esc(p))).join('')

export async function publish(f: Fetch, o: { token: string; sub: string; text: string }, now = new Date()) {
  const r = await must(await f('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json', 'LinkedIn-Version': apiVersion(now), 'X-Restli-Protocol-Version': '2.0.0' },
    body: JSON.stringify({
      author: `urn:li:person:${o.sub}`, commentary: littleText(o.text), visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    }),
  }), 'Publicacao')
  return r.headers.get('x-restli-id') ?? ''
}

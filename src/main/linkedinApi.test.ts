import assert from 'node:assert/strict'
import test from 'node:test'
import { apiVersion, authUrl, exchange, littleText, publish, REDIRECT, waitForCode } from './linkedinApi.ts'

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })

test('linkedin api: escape do little text e hashtag clicavel', () => {
  assert.equal(littleText('Novo (beta) @time: 50% *off* #GameDev #indie_br!'), 'Novo \\(beta\\) \\@time: 50% \\*off\\* {hashtag|\\#|GameDev} {hashtag|\\#|indie\\_br}!')
  assert.equal(littleText('a\\b'), 'a\\\\b')
})

test('linkedin api: versao de 2 meses atras, virando o ano', () => {
  assert.equal(apiVersion(new Date(2026, 8, 29)), '202607')
  assert.equal(apiVersion(new Date(2026, 0, 5)), '202511')
})

test('linkedin api: url de autorizacao leva escopos, retorno e state', () => {
  const u = new URL(authUrl('cid', 's1'))
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT)
  assert.equal(u.searchParams.get('scope'), 'openid profile w_member_social')
  assert.equal(u.searchParams.get('state'), 's1')
})

test('linkedin api: troca o codigo, le o perfil e publica com o autor certo; 401 pede reconexao', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/accessToken')) return res(200, { access_token: 'tk', expires_in: 5184000 })
    if (url.endsWith('/userinfo')) return res(200, { sub: 'abc', name: 'Fe' })
    return res(201, {}, { 'x-restli-id': 'urn:li:share:9' })
  }) as typeof fetch
  const a = await exchange(f, { clientId: 'c', clientSecret: 's', code: 'k' }, 0)
  assert.deepEqual(a, { token: 'tk', expiresAt: 5184000000, sub: 'abc', name: 'Fe' })
  assert.equal(await publish(f, { token: 'tk', sub: 'abc', text: 'oi' }, new Date(2026, 8, 1)), 'urn:li:share:9')
  const body = JSON.parse(String(calls[2].init!.body))
  assert.equal(body.author, 'urn:li:person:abc')
  assert.equal((calls[2].init!.headers as any)['LinkedIn-Version'], '202607')
  await assert.rejects(publish((async () => res(401, {})) as any, { token: 'x', sub: 'abc', text: 'oi' }), /conecte de novo/)
})

test('linkedin api: retorno local aceita so o state certo', async () => {
  const w = waitForCode('ok', 5000, 47899)
  const bad = await fetch('http://127.0.0.1:47899/callback?code=x&state=outro')
  assert.equal(bad.status, 400)
  await fetch('http://127.0.0.1:47899/callback?code=abc&state=ok')
  assert.equal(await w.done, 'abc')
  const n = waitForCode('ok', 5000, 47899)
  const refused = assert.rejects(n.done, /recusou/)
  await fetch('http://127.0.0.1:47899/callback?error=user_cancelled&state=ok')
  await refused
})

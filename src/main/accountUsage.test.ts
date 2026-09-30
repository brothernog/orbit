import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountUsageService, type AccountUsage } from './accountUsage.ts'

const usage: AccountUsage = { fiveHour: { utilization: 48, resets_at: '2026-10-01T00:00:00Z' }, sevenDay: null }
const deferred = () => {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
  const promise = new Promise<unknown>((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  let now = Date.parse('2026-09-30T20:00:00Z')
  const identities = new Map<number, string | null>([[1, 'profile-a'], [2, 'profile-b']])
  const stored = new Map<number, { identity?: string; usage: AccountUsage }>()
  const requests: (ReturnType<typeof deferred> & { id: number; signal: AbortSignal })[] = []
  const events: { id: number; usage: AccountUsage | null }[] = []
  const deps = {
    identity: (id: number) => identities.get(id) ?? null,
    read: (id: number, identity: string) => { const v = stored.get(id); return v && (!v.identity || v.identity === identity) ? v.usage : null },
    write: (id: number, identity: string, usage: AccountUsage) => { stored.set(id, { identity, usage }) },
    clear: (id: number) => { stored.delete(id) },
    request: (id: number, signal: AbortSignal) => {
      const request = { ...deferred(), id, signal }
      signal.addEventListener('abort', () => request.reject(signal.reason), { once: true })
      requests.push(request); return request.promise
    },
    emit: (id: number, usage: AccountUsage | null) => { events.push({ id, usage }) },
    now: () => now
  }
  return { service: createAccountUsageService(deps), deps, identities, stored, requests, events, advance: (ms: number) => { now += ms }, seenAt: () => new Date(now).toISOString() }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('snapshot persistido aparece imediatamente, sem aguardar rede; aberturas compartilham uma consulta', async () => {
  const f = fixture()
  f.stored.set(1, { usage }) // cache legado sem timestamp/perfil
  assert.deepEqual(f.service.snapshot(1), { ...usage, cached: true })
  assert.equal(f.requests.length, 0) // aquecimento e estritamente local
  const [a, b] = await Promise.all([f.service.get(1), f.service.get(1)])
  assert.deepEqual(a, { ...usage, cached: true })
  assert.deepEqual(b, a)
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve({ ...usage, fiveHour: { ...usage.fiveHour, utilization: 55 } })
  await settle()
  assert.equal(f.stored.get(1)?.usage.fiveHour?.utilization, 55)
  assert.equal(f.stored.get(1)?.usage.seenAt, f.seenAt())
  assert.equal(f.events[0].usage?.cached, undefined)
})

test('sem cache a primeira consulta e compartilhada, sem preencher campos desconhecidos com zero', async () => {
  const f = fixture(), a = f.service.get(1), b = f.service.get(1)
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve({ fiveHour: null, sevenDay: { utilization: null } })
  assert.deepEqual(await a, { fiveHour: null, sevenDay: null, seenAt: f.seenAt() })
  assert.deepEqual(await b, await a)
  assert.equal(f.service.snapshot(2), null)
})

test('TTL de 60 segundos usa timestamp persistido e cada conta tem sua propria consulta', async () => {
  const f = fixture()
  f.stored.set(1, { identity: 'profile-a', usage: { ...usage, seenAt: f.seenAt() } })
  await f.service.get(1)
  f.advance(59_999); await f.service.get(1)
  assert.equal(f.requests.length, 0)
  f.advance(1); await f.service.get(1)
  const second = f.service.get(2)
  assert.deepEqual(f.requests.map(r => r.id), [1, 2])
  f.requests[0].resolve(usage); f.requests[1].resolve(usage)
  await second; await settle()
  const reopened = createAccountUsageService(f.deps)
  await reopened.get(1)
  assert.equal(f.requests.length, 2) // TTL continua depois de recriar o servico
})

test('falha preserva percentuais e timestamp conhecidos; cooldown evita insistir a cada abertura', async () => {
  const f = fixture(), seenAt = f.seenAt()
  f.stored.set(1, { usage: { ...usage, seenAt } }); f.advance(60_000)
  await f.service.get(1)
  f.requests[0].reject(Error('consulta indisponivel'))
  await settle()
  const cached = await f.service.get(1)
  assert.deepEqual(cached, { ...usage, seenAt, cached: true, refreshError: 'consulta indisponivel' })
  assert.equal(f.stored.get(1)?.usage.seenAt, seenAt)
  assert.deepEqual(f.events[0], { id: 1, usage: cached })
  assert.equal(f.requests.length, 1)
  f.advance(60_000); await f.service.get(1)
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve(usage); await settle()
})

test('sem dados conhecidos a falha e explicita e tambem respeita cooldown', async () => {
  const f = fixture(), result = f.service.get(1)
  f.requests[0].reject(Error('sem credencial'))
  await assert.rejects(result, /sem credencial/)
  await assert.rejects(f.service.get(1), /sem credencial/)
  assert.equal(f.requests.length, 1)
  assert.equal(f.stored.size, 0)
  assert.equal(f.events.length, 0)
})

test('timeout proprio encerra consulta pendente e mantem cache', async t => {
  const controller = new AbortController()
  const timeout = t.mock.method(AbortSignal, 'timeout', () => controller.signal)
  const f = fixture()
  f.stored.set(1, { usage })
  await f.service.get(1)
  assert.deepEqual(timeout.mock.calls[0].arguments, [10_000])
  controller.abort(Error('tempo esgotado'))
  await settle()
  assert.equal((await f.service.get(1)).refreshError, 'tempo esgotado')
  assert.equal(f.service.snapshot(1)?.fiveHour?.utilization, 48)
})

test('invalidacao de login limpa snapshot, emite null e recusa respostas/writers antigos', async () => {
  const f = fixture(), writer = f.service.writer(1)
  writer(usage)
  f.advance(60_000)
  await f.service.get(1)
  f.service.invalidate(1)
  assert.deepEqual(f.events.at(-1), { id: 1, usage: null })
  const eventCount = f.events.length
  writer(usage)
  f.requests[0].resolve(usage)
  await settle()
  assert.equal(f.events.length, eventCount)
  assert.equal(f.service.snapshot(1), null)
  assert.equal(f.stored.size, 0)
})

test('perfil alterado ou conta excluida impede resposta e snapshot de outra identidade', async () => {
  const f = fixture(), writer = f.service.writer(1), result = f.service.get(1)
  f.identities.set(1, 'new-profile')
  f.requests[0].resolve(usage)
  await assert.rejects(result, /conta mudou/)
  writer(usage)
  f.stored.set(1, { identity: 'profile-a', usage })
  assert.equal(f.service.snapshot(1), null)
  assert.equal(f.events.length, 0)
  const newWriter = f.service.writer(1)
  f.identities.delete(1)
  newWriter(usage)
  assert.equal(f.service.snapshot(1), null)
  await assert.rejects(f.service.get(1), /Conta indisponivel/)
})

test('snapshots do chat usam o mesmo cache e evento, suprimindo refresh enquanto recentes', async () => {
  const f = fixture()
  f.service.writer(1)(usage)
  assert.deepEqual(f.events[0], { id: 1, usage: { ...usage, seenAt: f.seenAt() } })
  await f.service.get(1)
  assert.equal(f.requests.length, 0)
  assert.equal(f.stored.get(1)?.identity, 'profile-a')
})

test('snapshot do chat durante refresh vence resposta ou erro HTTP atrasado', async () => {
  for (const persisted of [false, true]) for (const failed of [false, true]) {
    const f = fixture()
    if (persisted) f.stored.set(1, { usage })
    const result = f.service.get(1)
    f.advance(1000)
    f.service.writer(1)({ ...usage, fiveHour: { ...usage.fiveHour!, utilization: 55 } })
    const latest = f.stored.get(1)!.usage
    f.advance(1000)
    if (failed) f.requests[0].reject(Error('erro antigo'))
    else f.requests[0].resolve(usage)
    await result; await settle()
    assert.deepEqual(f.stored.get(1)?.usage, latest)
    assert.deepEqual(f.events, [{ id: 1, usage: latest }])
    assert.deepEqual(await f.service.get(1), { ...latest, cached: true })
    assert.equal(f.requests.length, 1)
  }
})

test('refresh inteiro passa pelo gate de manutencao antes de consultar ou gravar', async () => {
  const f = fixture(), gate = deferred()
  const guarded = createAccountUsageService({ ...f.deps, refreshGuard: async work => { await gate.promise; return work() } })
  f.stored.set(1, { usage })
  await guarded.get(1)
  assert.equal(f.requests.length, 0)
  gate.resolve(undefined); await settle()
  f.requests[0].resolve(usage); await settle()
  assert.equal(f.events[0].usage?.seenAt, f.seenAt())
})

// Contas Claude: linha do banco, pasta de perfil efetiva, ambiente da CLI, lista com colisoes/login e consulta de uso.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { claudeEnv, loginState } from './providers.ts'
import { fail } from './guard.ts'

export function createAccounts(db: DatabaseSync) {
  const accountRow = (id?: number | null) => (id ? (db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as any) : null)
  // Pasta de perfil efetiva; contas que apontam para a mesma pasta compartilham (e sobrescrevem) o mesmo login.
  const dirKey = (a: any) => path.resolve(a.config_dir ?? path.join(os.homedir(), '.claude')).toLowerCase()
  const accountEnv = (accountId?: number | null) => claudeEnv(accountRow(accountId)?.config_dir ?? null).env

  function listAccounts() {
    const rows = db.prepare('SELECT * FROM accounts ORDER BY id').all() as any[]
    return rows.map(a => ({
      ...a,
      collision: rows.some(o => o.id !== a.id && dirKey(o) === dirKey(a)),
      login: loginState(dirKey(a)) ?? null
    }))
  }

  // Endpoint nao documentado usado pelo /usage do Claude Code; nao prova o estado do login.
  async function fetchUsage(accountId: number, signal: AbortSignal) {
    const acc = accountRow(accountId) ?? fail('Conta inexistente.')
    const dir = acc.config_dir ?? path.join(os.homedir(), '.claude')
    const file = path.join(dir, '.credentials.json')
    if (!fs.existsSync(file)) throw new Error('Sem credencial local para consultar uso (recurso opcional; o chat nao depende dele).')
    let token: unknown
    try { token = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth?.accessToken } catch { throw Error('Credencial local invalida para consultar uso.') }
    if (typeof token !== 'string' || !token) throw Error('Sem credencial local para consultar uso (recurso opcional; o chat nao depende dele).')
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal
    })
    // Endpoint nao documentado e opcional: recusa aqui NAO prova que o login falhou (veja o estado da conta).
    if (res.status === 401) throw new Error('Consulta de uso recusada (401). O estado do login e verificado a parte.')
    if (res.status === 429) throw new Error('Muitas consultas de uso. Tente de novo em alguns minutos.')
    if (!res.ok) throw new Error(`Falha ao ler uso (${res.status}).`)
    const j = await res.json()
    return { fiveHour: j.five_hour ?? null, sevenDay: j.seven_day ?? null }
  }

  return { accountRow, dirKey, accountEnv, listAccounts, fetchUsage }
}

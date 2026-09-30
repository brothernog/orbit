// Integração LinkedIn: cofre e abertura do navegador fornecidos pela composição Electron.
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { asStr, fail } from './guard.ts'
import { draftFile, markPublished } from './linkedin.ts'
import { authUrl, exchange, publish, REDIRECT, waitForCode } from './linkedinApi.ts'
// getSelectedStorageBackend: so existe no Linux; 'basic_text' = sem keyring, a "cifra" usa senha fixa e equivale a texto puro.
type Vault = { decryptString: (b: Buffer) => string; encryptString: (s: string) => Buffer; isEncryptionAvailable: () => boolean; getSelectedStorageBackend?: () => string }
export function createLinkedInService(d: { getSetting: (k: string) => string | undefined; setSetting: (k: string, v: string) => unknown; safeStorage: Vault; openExternal: (url: string) => unknown; linkedinDir: string }) {
  const { getSetting, setSetting, safeStorage, openExternal, linkedinDir } = d
  // ---- LinkedIn pela API oficial: Client ID/Secret do app do usuario e o acesso ficam cifrados pelo sistema (safeStorage), nunca em texto puro,
  // e nunca voltam para o renderer. Publicar e sempre um clique do usuario.
  type LiAuth = { clientId: string; clientSecret: string; token?: string; expiresAt?: number; sub?: string; name?: string }
  const liAuth = (): LiAuth | null => {
    const v = getSetting('linkedinAuth')
    try { return v ? JSON.parse(safeStorage.decryptString(Buffer.from(v, 'base64'))) : null } catch { return null }
  }
  const setLiAuth = (a: LiAuth) => {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') fail('O sistema nao oferece cofre para guardar a chave com seguranca; nada foi salvo.')
    setSetting('linkedinAuth', safeStorage.encryptString(JSON.stringify(a)).toString('base64'))
  }
  const liStatus = () => {
    const a = liAuth()
    return { redirect: REDIRECT, clientId: a?.clientId ?? '', connected: !!a?.token && (a.expiresAt ?? 0) > Date.now(), name: a?.name ?? '', expiresAt: a?.expiresAt ?? null }
  }
  let liPending: { close: () => void } | null = null
  async function liConnect(clientId: unknown, clientSecret: unknown) {
    const id = asStr(clientId, 'Client ID', 200).trim()
    const saved = liAuth()
    const secret = asStr(clientSecret ?? '', 'Client Secret', 500).trim() || (saved?.clientId === id ? saved.clientSecret : '')
    if (!id || !secret) fail('Preencha o Client ID e o Client Secret do seu app do LinkedIn.')
    setLiAuth({ clientId: id, clientSecret: secret })
    liPending?.close()
    const state = randomBytes(16).toString('hex')
    const w = waitForCode(state)
    liPending = w
    openExternal(authUrl(id, state))
    try { setLiAuth({ clientId: id, clientSecret: secret, ...await exchange(fetch, { clientId: id, clientSecret: secret, code: await w.done }) }) }
    finally { if (liPending === w) liPending = null }
    return liStatus()
  }
  async function liPost(name: unknown) {
    const a = liAuth()
    if (!a?.token || !a.sub || (a.expiresAt ?? 0) <= Date.now()) return fail('LinkedIn nao conectado ou acesso expirado: conecte de novo.')
    const n = asStr(name, 'rascunho', 200)
    const text = fs.readFileSync(draftFile(linkedinDir, n), 'utf8').trim()
    if (!text || text.length > 3000) fail('O post precisa ter entre 1 e 3.000 caracteres.')
    const urn = await publish(fetch, { token: a.token, sub: a.sub, text })
    markPublished(linkedinDir, n, new Date(), urn)
    return urn ? `https://www.linkedin.com/feed/update/${urn}/` : ''
  }


  return { liStatus, liConnect, liPost, cancelConnect: () => liPending?.close() }
}

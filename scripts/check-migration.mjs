// Testa a migracao do banco SOBRE UMA COPIA: nada e alterado no arquivo original e nenhum conteudo e impresso
// (so contagens). Uso: node scripts/check-migration.mjs "%APPDATA%\gaming-planning-dashboard\dashboard.db"
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const src = process.argv[2]
if (!src || !fs.existsSync(src)) { console.error('Uso: node scripts/check-migration.mjs <caminho do dashboard.db>'); process.exit(2) }
const here = path.dirname(fileURLToPath(import.meta.url))
const { openDb, MIGRATIONS } = await import(pathToFileURL(path.join(here, '../src/main/db.ts')).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-migcheck-'))
const copy = path.join(tmp, 'dashboard.db')
fs.copyFileSync(src, copy)
const count = (db, t) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n } catch { return null } }
const before = new DatabaseSync(copy, { readOnly: true })
const b = { version: before.prepare('PRAGMA user_version').get().user_version, messages: count(before, 'messages'), pins: count(before, 'pins'), accounts: count(before, 'accounts'), chats: count(before, 'chats') }
before.close()
try {
  const db = openDb(copy)
  const a = { version: db.prepare('PRAGMA user_version').get().user_version, messages: count(db, 'messages'), tasks: count(db, 'tasks'), sessions: count(db, 'task_sessions'), semTarefa: db.prepare('SELECT COUNT(*) n FROM messages WHERE task_id IS NULL').get().n }
  db.close()
  console.log('antes :', JSON.stringify(b))
  console.log('depois:', JSON.stringify(a), `(versao alvo ${MIGRATIONS.length})`)
  const ok = a.version === MIGRATIONS.length && a.messages === (b.messages ?? 0) && a.semTarefa === 0
  console.log(ok ? 'OK: migracao preservou todas as mensagens.' : 'FALHA: contagens divergem.')
  process.exitCode = ok ? 0 : 1
} catch (e) {
  console.log('antes :', JSON.stringify(b))
  console.log('FALHA na migracao (o original nao foi tocado):', e.message)
  process.exitCode = 1
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

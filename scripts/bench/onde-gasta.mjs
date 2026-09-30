// "Onde se gasta": le o banco do app em MODO LEITURA e imprime so numeros (nenhum texto de conversa, nenhum titulo). Nao chama nenhuma CLI.
// Uso (feche o app ou use uma copia): node scripts/bench/onde-gasta.mjs "%APPDATA%\gaming-planning-dashboard\dashboard.db" [--dias 30]
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) { console.error('Uso: node scripts/bench/onde-gasta.mjs <dashboard.db> [--dias 30]'); process.exit(2) }
const i = process.argv.indexOf('--dias')
const days = i >= 0 ? Number(process.argv[i + 1]) || undefined : undefined
const { whereReport } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/main/usageReport.ts')).href)
const db = new DatabaseSync(file, { readOnly: true })
try { console.log(whereReport(db, { days })) } finally { db.close() }

// Relatorio A x B do benchmark: le SOMENTE os dois bancos indicados (abertos em modo leitura) e imprime a tabela.
// Uso: node scripts/bench/report.mjs <dashboard.db da versao A> <dashboard.db da versao B> [jarvis.json]
// Nenhuma chamada a CLI, nenhum texto de conversa impresso: so numeros de uso das tarefas cuja 1a mensagem comeca com "BENCH-<id>:".
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [dbA, dbB, jarvisFile] = process.argv.slice(2)
if (!dbA || !dbB || !fs.existsSync(dbA) || !fs.existsSync(dbB)) { console.error('Uso: node scripts/bench/report.mjs <banco A> <banco B> [resultado do jarvis.json]'); process.exit(2) }
const here = path.dirname(fileURLToPath(import.meta.url))
const { benchSamples, compareTable } = await import(pathToFileURL(path.join(here, '../../src/main/bench.ts')).href)
const read = f => { const db = new DatabaseSync(f, { readOnly: true }); try { return benchSamples(db) } finally { db.close() } }
const a = read(dbA), b = read(dbB)
if (jarvisFile) { const j = JSON.parse(fs.readFileSync(jarvisFile, 'utf8')); a.push(...j.A); b.push(...j.B) }
console.log(`# Benchmark A x B (${new Date().toISOString().slice(0, 10)})\n\nA = ${dbA}\nB = ${dbB}\nNumeros informados pelos provedores; "—" = o provedor nao informou. Faixas sobrepostas = sem diferenca mensuravel.\n`)
console.log(compareTable(a, b))

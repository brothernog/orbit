// Blender local: cabeçalho .blend sem executar nada, listagem limitada, sonda da versão e execução headless SOMENTE LEITURA
// do script empacotado (resources/blender/orbit_inspect.py), com cache por arquivo/argumentos e diagnóstico de logs. Sem 'electron'.
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Transform } from 'node:stream'
import zlib from 'node:zlib'
import { normalizeCommand } from './commands.ts'
import { SKIP_DIRS } from './engines.ts'
import { cliSpawn, killTree, resolveCli } from './providers.ts'

export const BLENDER_LIMITS = { runMs: 60_000, probeMs: 10_000, outputBytes: 2 * 1024 * 1024, maxRuns: 2, cacheEntries: 120, cacheMs: 10 * 60_000 }
export type BlendHeader = { version: string | null; pointer: 4 | 8 | null; endian: 'little' | 'big' | null; compressed: 'gzip' | 'zstd' | null }
export type BlendFile = { rel: string; abs: string; size: number; mtimeMs: number; backups: number }
export type BlenderDiagnostic = { severity: 'error' | 'warning' | 'info'; message: string; file?: string; line?: number; count: number; outputLines: number[] }

// Formatos: legado "BLENDER_v402" (ponteiro _=4/-=8, v=little/V=big, versão 3 dígitos) e Blender 5 "BLENDER17-01v0500".
export function parseBlendHeader(b: Buffer): Omit<BlendHeader, 'compressed'> | null {
  const s = b.subarray(0, 17).toString('latin1')
  const legacy = /^BLENDER([_-])([vV])(\d{3})/.exec(s), modern = /^BLENDER\d\d-\d\d([vV])(\d{4})/.exec(s)
  const ver = (n: number) => `${Math.floor(n / 100)}.${n % 100}`
  if (modern) return { version: ver(Number(modern[2])), pointer: 8, endian: modern[1] === 'v' ? 'little' : 'big' }
  if (legacy) return { version: ver(Number(legacy[3])), pointer: legacy[1] === '_' ? 4 : 8, endian: legacy[2] === 'v' ? 'little' : 'big' }
  return null
}

// Descomprime só o início (primeiro bloco basta para o cabeçalho); zstd depende do Node do app ter o decodificador.
function inflateHead(buf: Buffer, d: Transform): Promise<Buffer | null> {
  return new Promise(resolve => {
    let got = Buffer.alloc(0), done = false
    const end = (r: Buffer | null) => { if (done) return; done = true; resolve(r); d.destroy() }
    d.on('data', (c: Buffer) => { got = Buffer.concat([got, c]); if (got.length >= 17) end(got) })
    d.on('error', () => end(got.length ? got : null)); d.on('end', () => end(got.length ? got : null))
    d.end(buf)
  })
}
export async function readBlendHeader(abs: string): Promise<BlendHeader | null> {
  const fd = fs.openSync(abs, 'r')
  let head: Buffer
  try { const b = Buffer.alloc(64 * 1024); head = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)) } finally { fs.closeSync(fd) }
  const plain = parseBlendHeader(head)
  if (plain) return { ...plain, compressed: null }
  const kind = head[0] === 0x1f && head[1] === 0x8b ? 'gzip' : head.readUInt32LE(0) === 0xfd2fb528 ? 'zstd' : null
  if (!kind) return null
  const make: (() => Transform) | undefined = kind === 'gzip' ? zlib.createGunzip : (zlib as any).createZstdDecompress
  const inner = make ? await inflateHead(head, make()) : null
  const parsed = inner && parseBlendHeader(inner)
  if (parsed) return { ...parsed, compressed: kind }
  return inner ? null : { version: null, pointer: null, endian: null, compressed: kind } // descomprimiu e não é .blend: inválido
}

// .blend dentro do escopo, sem ler conteúdo; backups (.blend1..N, .blend@) só contados.
export function listBlendFiles(cwd: string, allow: (rel: string) => boolean, internal: string[], limit = 20_000, max = 500) {
  const files: BlendFile[] = [], backups = new Map<string, number>()
  let seen = 0, truncated = false
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > limit) { truncated = true; return }
      const abs = path.join(dir, e.name), rel = path.relative(cwd, abs).split(path.sep).join('/')
      if (e.isDirectory()) { if (depth < 12 && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !internal.includes(e.name)) visit(abs, depth + 1); continue }
      if (!e.isFile() || !allow(rel)) continue
      const backup = /^(.*\.blend)(?:\d+|@)$/i.exec(rel)
      if (backup) backups.set(backup[1], (backups.get(backup[1]) ?? 0) + 1)
      else if (/\.blend$/i.test(e.name)) {
        if (files.length >= max) { truncated = true; continue }
        const st = fs.statSync(abs)
        files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs, backups: 0 })
      }
    }
  }
  visit(cwd, 0)
  for (const f of files) f.backups = backups.get(f.rel) ?? 0
  return { files, truncated, backups: [...backups.values()].reduce((a, b) => a + b, 0) }
}

// Ambiente sem injeção de Python/scripts do usuário (PYTHONPATH, PYTHONSTARTUP, BLENDER_USER_SCRIPTS...).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:PYTHON|BLENDER_)/i.test(k)))

function run(exe: string, args: string[], cwd: string, ms: number, signal?: AbortSignal): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('Consulta cancelada.'))
    const child = cliSpawn(exe, args, { cwd, env: cleanEnv() })
    const chunks: Buffer[] = []
    let size = 0, failed: Error | null = null
    const stop = (e: Error) => { if (failed) return; failed = e; killTree(child) }
    const timer = setTimeout(() => stop(Error(`Tempo limite de ${Math.round(ms / 1000)} s ao executar o Blender.`)), ms)
    const abort = () => stop(Error('Consulta cancelada.'))
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin?.on('error', () => {}); child.stdin?.end()
    // Guarda só o fim (o resultado vem por último); avisos em massa ao abrir o arquivo não derrubam a consulta.
    const append = (b: Buffer) => { chunks.push(b); size += b.length; while (size - chunks[0].length >= BLENDER_LIMITS.outputBytes) size -= chunks.shift()!.length }
    child.stdout?.on('data', append); child.stderr?.on('data', append)
    child.once('error', e => { failed ??= e })
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (failed) reject(failed); else resolve({ out: Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), code })
    })
  })
}

// Sonda cacheada por executável configurado: sucesso 10 min, falha 30 s (o usuário pode estar instalando).
const probes = new Map<string, { at: number; ok: boolean; value: Promise<{ exe: string; version: string }> }>()
export function blenderProbe(executable: string, cwd: string): Promise<{ exe: string; version: string }> {
  const hit = probes.get(executable)
  if (hit && Date.now() - hit.at < (hit.ok ? 600_000 : 30_000)) return hit.value
  const entry = { at: Date.now(), ok: true, value: (async () => {
    const program = normalizeCommand({ name: 'Blender', purpose: 'test', program: executable, args: [] }).program
    const exe = path.isAbsolute(program) ? program : await resolveCli(program)
    if (!exe) throw Error(`Executável do Blender não encontrado ("${program}"); configure o caminho no organizador.`)
    const { out } = await run(exe, ['--version'], cwd, BLENDER_LIMITS.probeMs)
    const version = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1]
    if (!version) throw Error('O executável configurado não respondeu como Blender a --version.')
    return { exe, version }
  })() }
  entry.value.catch(() => { entry.ok = false })
  probes.set(executable, entry)
  if (probes.size > 20) probes.delete(probes.keys().next().value as string)
  return entry.value
}
export const newerThan = (file: string | null, blender: string) => {
  if (!file) return false
  const [a, b] = file.split('.').map(Number), [c, d] = blender.split('.').map(Number)
  return a > c || a === c && b > d
}

// Script empacotado: raízes definidas pelo processo principal (resources/blender em dev; process.resourcesPath/blender no pacote).
let roots: string[] = []
export const setBlenderScriptRoots = (r: string[]) => { roots = r.filter(Boolean) }
export function blenderScript(): { file: string; hash: string } {
  for (const r of roots) {
    const file = path.join(r, 'orbit_inspect.py')
    try { return { file, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') } } catch {}
  }
  throw Error(`Script de inspeção do Blender ausente no pacote do app (procurado em: ${roots.join('; ') || 'nenhum local'}); reinstale o app.`)
}

export type InspectArgs = { mode: string; object?: string; scene?: string }
const cache = new Map<string, { at: number; text: string; deps: string[]; sig: string }>()
// Assinatura das dependências externas (texturas, bibliotecas): criar/alterar uma delas invalida o cache sem mudar o .blend.
const depSig = (deps: string[]) => createHash('sha256').update(deps.map(p => { try { const st = fs.statSync(p); return `${st.size}:${st.mtimeMs}` } catch { return '-' } }).join('|')).digest('hex')
const fresh = (key: string) => { const e = cache.get(key); return e && Date.now() - e.at < BLENDER_LIMITS.cacheMs && depSig(e.deps) === e.sig ? e : undefined }
// No máximo MAX_RUNS Blenders simultâneos (memória); a vaga passa direto ao próximo da fila.
let active = 0
const waiting: (() => void)[] = []
function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(Error('Consulta cancelada.'))
  if (active < BLENDER_LIMITS.maxRuns) { active++; return Promise.resolve() }
  return new Promise((resolve, reject) => {
    const go = () => { signal?.removeEventListener('abort', abort); resolve() }
    const abort = () => { waiting.splice(waiting.indexOf(go), 1); reject(Error('Consulta cancelada.')) }
    waiting.push(go); signal?.addEventListener('abort', abort, { once: true })
  })
}
const release = () => { const next = waiting.shift(); if (next) next(); else active-- }
const locks = new Map<string, Promise<unknown>>()
export const blenderStats = { runs: 0 }
export const clearBlenderCache = () => cache.clear()

// Uma execução por arquivo (as demais esperam e costumam sair do cache). -Y + open_mainfile(use_scripts=False) no script desativam
// scripts/drivers embutidos no .blend; --factory-startup ignora preferências/add-ons/scripts do usuário; o script nunca salva.
// A mesma abertura devolve os modos companheiros (mesmos filtros), cacheados à parte. Cache: caminho+tamanho+mtime+args+script+exe.
export async function inspectBlend(o: { exe: string; version: string; file: string; root: string; args: InspectArgs; signal?: AbortSignal }): Promise<{ text: string; key: string; cached: boolean }> {
  const script = blenderScript(), st = fs.statSync(o.file)
  const keyOf = (args: InspectArgs) => createHash('sha256').update(JSON.stringify([o.file, st.size, st.mtimeMs, args, script.hash, o.exe, o.version, o.root])).digest('hex')
  const key = keyOf(o.args), hit = fresh(key)
  if (hit) return { text: hit.text, key, cached: true }
  const previous = locks.get(o.file) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(async () => {
    const again = fresh(key)
    if (again) return { text: again.text, key, cached: true }
    const nonce = randomBytes(12).toString('hex')
    // deadline: alarme POSIX no próprio Blender (encerra mesmo se o app morrer antes do kill).
    const json = JSON.stringify({ ...o.args, root: o.root, file: o.file, nonce, companions: true, deadline: Math.ceil(BLENDER_LIMITS.runMs / 1000) + 5 })
    await acquire(o.signal)
    let res: { out: string; code: number | null }
    try { blenderStats.runs++; res = await run(o.exe, ['-b', '--factory-startup', '-Y', '--python', script.file, '--', json], o.root, BLENDER_LIMITS.runMs, o.signal) } finally { release() }
    const { out, code } = res
    const m = new RegExp(`<<ORBIT-${nonce}>>(.*?)<<END-${nonce}>>`, 's').exec(out)
    if (!m) {
      const d = blenderDiagnostics(out).items.filter(i => i.severity !== 'info').slice(0, 3).map(i => i.message).join(' | ')
      throw Error(`Blender não produziu resultado (código ${code}).${d ? ' ' + d.slice(0, 400) : ''}`)
    }
    const r = JSON.parse(m[1])
    if (r.error) throw Error(String(r.error))
    const text = String(r.text), deps = Array.isArray(r.deps) ? r.deps.filter((p: unknown) => typeof p === 'string') : [], sig = depSig(deps)
    const more = r.more && typeof r.more === 'object' ? Object.entries(r.more).filter(([mode, t]) => mode !== o.args.mode && typeof t === 'string') : []
    for (const [k, t] of [...more.map(([mode, t]) => [keyOf({ ...o.args, mode }), t as string]), [key, text]]) {
      cache.delete(k); cache.set(k, { at: Date.now(), text: t, deps, sig })
    }
    while (cache.size > BLENDER_LIMITS.cacheEntries) cache.delete(cache.keys().next().value as string)
    return { text, key, cached: false }
  })
  locks.set(o.file, current)
  try { return await current } finally { if (locks.get(o.file) === current) locks.delete(o.file) }
}

// Log do Blender: tracebacks Python (frame do workspace, senão o último + exceção; traceback aninhado em RuntimeError/"Error: Python:"
// mostra a causa), Error/Warning (inclui CLOG "ERROR (bke.x):" e logging "12:00:00 | ERROR:"), arquivos ausentes e "Read blend:" (info).
// Agrupa repetições. o.cwd (opcional, mesmo formato da receita de engine) prioriza frames de scripts do projeto.
export function blenderDiagnostics(output: string, o: { cwd?: string } = {}): { items: BlenderDiagnostic[]; errorCount: number; warningCount: number; totalLines: number } {
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/), raw: BlenderDiagnostic[] = []
  const root = o.cwd ? path.resolve(o.cwd) + path.sep : null, own = (f: string) => !!root && path.resolve(root, f).startsWith(root)
  const nested = /Traceback \(most recent call last\):$/
  const exc = /^[\w.]+(?:Error|Exception|Exit|Interrupt|Warning)\b/
  // Consome frames indentados a partir de i; devolve o frame preferido e o índice da última linha consumida.
  const frames = (i: number) => {
    let file: string | undefined, line: number | undefined, mine = false
    while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) {
      const fr = /^\s*File "([^"]+)", line (\d+)/.exec(lines[++i])
      if (fr && (!mine || own(fr[1]))) { file = fr[1]; line = Number(fr[2]); mine = own(fr[1]) }
    }
    return { file, line, i }
  }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    // "12:00:00 | ERROR:" = logging de add-on (glTF): vira aviso; o exportador registra ali até falhas opcionais (Draco ausente).
    const hit = /^(\d\d:\d\d:\d\d(?:\.\d+)? \| )?(ERROR|Error|WARN(?:ING)?|Warning)(?:\s*\([^)]*\))?\s*:\s*(.*)$/.exec(t)
    if (/^Traceback \(most recent call last\):/.test(t) || hit && nested.test(hit[3])) {
      const d: BlenderDiagnostic = { severity: 'error', message: hit ? hit[3].replace(nested, '').trim() || 'Traceback Python' : 'Traceback Python', count: 1, outputLines: [i + 1] }
      let fr = frames(i)
      if (fr.file) d.file = fr.file, d.line = fr.line
      i = fr.i
      // Exceção final; se ela embute outro traceback (RuntimeError do operador), segue até a causa e mantém o frame do projeto.
      while (i + 1 < lines.length && exc.test(lines[i + 1].trim())) {
        const m = lines[++i].trim()
        d.message = d.message === 'Traceback Python' ? m : `${d.message} ${m}`
        d.outputLines.push(i + 1)
        if (!nested.test(m)) break
        d.message = d.message.replace(nested, '').trim()
        fr = frames(i)
        if (fr.file && !(d.file && own(d.file))) d.file = fr.file, d.line = fr.line
        i = fr.i
      }
      raw.push(d); continue
    }
    if (hit) { raw.push({ severity: /^E/i.test(hit[2]) && !hit[1] ? 'error' : 'warning', message: hit[3], count: 1, outputLines: [i + 1] }); continue }
    const read = /^Read blend:\s*"?([^"]+)"?/.exec(t)
    if (read) { raw.push({ severity: 'info', message: 'Arquivo aberto', file: read[1], count: 1, outputLines: [i + 1] }); continue }
    if (/^Info: (?:Cannot find lib|LIB: .*missing)/.test(t) || /No such file or directory|not found|Unable to open|Cannot (?:read|open)/i.test(t))
      raw.push({ severity: 'warning', message: t.replace(/^Info:\s*/, ''), count: 1, outputLines: [i + 1] })
  }
  const grouped = new Map<string, BlenderDiagnostic>()
  for (const d of raw) {
    const k = JSON.stringify([d.severity, d.message, d.file, d.line]), prev = grouped.get(k)
    if (prev) { prev.count++; prev.outputLines.push(...d.outputLines) } else grouped.set(k, d)
  }
  return { items: [...grouped.values()], errorCount: raw.filter(d => d.severity === 'error').length, warningCount: raw.filter(d => d.severity === 'warning').length, totalLines: lines.length }
}

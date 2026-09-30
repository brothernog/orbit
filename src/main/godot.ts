// Godot local: metadados selecionados, argumentos explícitos e diagnóstico recuperável.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { samePath, safeJoin } from './guard.ts'
import { normalizeCommand, type ProjectCommand } from './commands.ts'
import { cliSpawn, killTree, resolveCli } from './providers.ts'

export type GodotConfig = { enabled: boolean; executable: string }
export type GodotPreset = { id: number; name: string; platform: string; embeddedPck: boolean; output: string | null }
export type GodotProject = { configVersion: number | null; features: string[]; version: string | null; language: 'GDScript' | 'C#' | 'unknown'; supported: boolean; mainScene: string | null; autoloads: { name: string; path: string; singleton: boolean }[]; presets: GodotPreset[]; warnings: string[] }
export type GodotAction = 'import' | 'check' | 'run' | 'editor' | 'export'
export type GodotArgs = { script?: string; scene?: string; preset?: string; output?: string; debug?: boolean; log?: string; headless?: boolean }
export type GodotDiagnostic = { severity: 'error' | 'warning'; message: string; file?: string; line?: number; origin?: string; count: number; outputLines: number[] }

export function godotOrganizer(db: DatabaseSync, game: string): { id: string; name: string; config: GodotConfig } | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='projectGroups'").get() as { value: string } | undefined
    const groups: unknown = JSON.parse(row?.value ?? '[]')
    if (!Array.isArray(groups)) return null
    const matches = groups.filter(g => Array.isArray(g?.games) && g.games.some((p: unknown) => typeof p === 'string' && samePath(p, game)))
    if (matches.length !== 1) return null
    const g = matches[0], configured = g.godot?.executable
    if (g.godot?.enabled !== true || typeof configured !== 'string' || typeof g.id !== 'string' || !g.id || typeof g.name !== 'string' || groups.filter(x => x?.id === g.id).length !== 1) return null
    const executable = configured.trim() || 'godot'
    normalizeCommand({ name: 'Godot', purpose: 'test', program: executable, args: [] })
    return { id: g.id, name: g.name, config: { enabled: true, executable: executable.trim() } }
  } catch { return null }
}

const MAX_CONFIG = 4 * 1024 * 1024
type Settings = Map<string, Map<string, string>>
function readConfig(cwd: string, file: string, allow?: (rel: string) => boolean): string {
  const abs = safeJoin(cwd, file)
  const canonical = path.relative(fs.realpathSync(cwd), abs).split(path.sep).join('/')
  if (canonical.split('/').some(p => ['.git', '.godot', '.import', '.worktrees', 'export_credentials.cfg'].includes(p))) throw Error(`"${file}" aponta para um arquivo interno/credencial fora das consultas Godot.`)
  if (allow && !allow(canonical)) throw Error(`"${file}" está fora do escopo desta delegação.`)
  if (!fs.statSync(abs).isFile()) throw Error(`"${file}" não é um arquivo.`)
  if (fs.statSync(abs).size > MAX_CONFIG) throw Error(`"${file}" excede 4 MiB; leia trechos com read_file_range.`)
  const b = fs.readFileSync(abs)
  if (b.includes(0)) throw Error(`"${file}" usa formato binário não suportado; consulte o editor Godot.`)
  return b.toString('utf8').replace(/^\uFEFF/, '')
}

// ConfigFile aceita valores em várias linhas; não executamos expressões Variant.
function settings(text: string): Settings {
  const out: Settings = new Map([['', new Map()]])
  let section = '', key = '', value = '', quoted = false, escaped = false, depth = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!key) {
      if (!line || line.startsWith(';')) continue
      if (/^\[[^\]]+\]$/.test(line)) { section = line.slice(1, -1); if (!out.has(section)) out.set(section, new Map()); continue }
      const m = line.match(/^([^=]+?)\s*=\s*(.*)$/)
      if (!m) throw Error('ConfigFile contém sintaxe não suportada; leia o arquivo com read_file_range.')
      key = m[1].trim(); value = ''; quoted = false; escaped = false; depth = 0
      rawValue(m[2])
    } else rawValue(raw)
    if (!quoted && depth === 0) { out.get(section)!.set(key, value.trim()); key = '' }
  }
  if (key || quoted || depth) throw Error('ConfigFile contém valor incompleto; leia o arquivo com read_file_range.')
  return out
  function rawValue(line: string) {
    if (value) value += '\n'
    for (const c of line) {
      if (!quoted && c === ';') break
      value += c
      if (escaped) { escaped = false; continue }
      if (quoted && c === '\\') { escaped = true; continue }
      if (c === '"') quoted = !quoted
      else if (!quoted && /[([{]/.test(c)) depth++
      else if (!quoted && /[)\]}]/.test(c)) { if (--depth < 0) throw Error('ConfigFile contém delimitador inválido; leia o arquivo com read_file_range.') }
    }
  }
}
function str(value: string | undefined): string | null {
  if (!value?.startsWith('"')) return null
  try { const v = JSON.parse(value); return typeof v === 'string' ? v : null } catch { return null }
}
function strings(value: string | undefined): string[] | null {
  if (!value) return null
  const v = value.replace(/^PackedStringArray\(([\s\S]*)\)$/, '[$1]')
  try { const a = JSON.parse(v); return Array.isArray(a) && a.every(x => typeof x === 'string') ? a : null } catch { return null }
}

export function godotProject(cwd: string, allow?: (rel: string) => boolean): GodotProject {
  const cfg = settings(readConfig(cwd, 'project.godot', allow)), app = cfg.get('application'), warnings: string[] = []
  const rawFeatures = app?.get('config/features'), parsedFeatures = strings(rawFeatures), features = parsedFeatures ?? []
  if (rawFeatures && !parsedFeatures) warnings.push('config/features tem formato não suportado; leia project.godot com read_file_range.')
  const version = features.find(f => /^\d+\.\d+(?:\.\d+)?$/.test(f)) ?? null
  const cv = cfg.get('')?.get('config_version'), configVersion = cv && /^\d+$/.test(cv) ? Number(cv) : null
  const language = features.includes('C#') || cfg.has('dotnet') ? 'C#' : configVersion === 5 && parsedFeatures ? 'GDScript' : 'unknown'
  const supported = configVersion === 5 && !!version?.startsWith('4.') && language === 'GDScript'
  if (!supported) warnings.push('Fluxo inicial suporta projetos Godot 4.x com GDScript e config/features reconhecido.')
  const rawScene = app?.get('run/main_scene'), parsedScene = str(rawScene)
  const mainScene = parsedScene?.startsWith('uid://') ? parsedScene : metadataPath(cwd, parsedScene, allow)
  if (rawScene && mainScene === null) warnings.push('run/main_scene tem formato não suportado; leia project.godot com read_file_range.')
  if (mainScene?.startsWith('uid://')) warnings.push('Cena principal usa UID; o Godot resolve ao executar. Para inspeção, informe o caminho da cena, sem consultar .godot.')
  const autoloads: GodotProject['autoloads'] = []
  for (const [name, raw] of cfg.get('autoload') ?? []) {
    const value = str(raw)
    if (value === null) { warnings.push(`Autoload "${name}" tem formato não suportado; consulte project.godot.`); continue }
    const ref = metadataPath(cwd, value.replace(/^\*/, ''), allow)
    if (!ref) { warnings.push('Um autoload tem caminho fora do projeto ou do escopo; não foi incluído.'); continue }
    autoloads.push({ name, path: ref, singleton: value.startsWith('*') })
  }
  const presets: GodotPreset[] = [], presetFile = safeJoin(cwd, 'export_presets.cfg')
  if (fs.existsSync(presetFile)) {
    if (allow && !allow(path.relative(fs.realpathSync(cwd), presetFile).split(path.sep).join('/'))) warnings.push('export_presets.cfg está fora do escopo; presets não lidos.')
    else {
      const exp = settings(readConfig(cwd, 'export_presets.cfg', allow))
      for (const [section, values] of exp) {
        const m = section.match(/^preset\.(\d+)$/)
        if (!m) continue
        const name = str(values.get('name')), platform = str(values.get('platform'))
        if (name === null || platform === null) { warnings.push(`Preset ${m[1]} tem formato não suportado; consulte export_presets.cfg.`); continue }
        const output = str(values.get('export_path'))
        presets.push({ id: Number(m[1]), name, platform, embeddedPck: exp.get(section + '.options')?.get('binary_format/embed_pck') === 'true', output: metadataPath(cwd, output, allow)?.replace(/^res:\/\//, '') ?? null })
      }
    }
  }
  return { configVersion, features, version, language, supported, mainScene, autoloads, presets, warnings }
}

function metadataPath(cwd: string, value: string | null, allow?: (rel: string) => boolean): string | null {
  if (!value || /[\0\r\n]/.test(value)) return null
  const rel = value.replace(/^res:\/\//, '').replace(/\\/g, '/')
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split('/').some(p => ['..', '.godot', '.import', '.git', '.worktrees'].includes(p))) return null
  try {
    const canonical = path.relative(fs.realpathSync(cwd), safeJoin(cwd, rel)).split(path.sep).join('/')
    return !allow || allow(canonical) ? 'res://' + canonical : null
  } catch { return null }
}

const CAPABILITIES = ['--headless', '--path', '--import', '--check-only', '--script', '--export-release', '--export-debug', '--editor', '--quit', '--log-file']
export async function godotProbe(executable: string, cwd: string): Promise<{ executable: string; version: string; major: number; capabilities: string[] }> {
  const program = normalizeCommand({ name: 'Godot', purpose: 'test', program: executable, args: [] }).program
  const exe = path.isAbsolute(program) ? program : await resolveCli(program)
  if (!exe) throw Error('Executável Godot não encontrado; selecione o binário do editor.')
  normalizeCommand({ name: 'Godot', purpose: 'test', program: exe, args: [] })
  const version = (await probe(exe, ['--version'], cwd)).trim(), major = Number(version.match(/^(\d+)\.\d+/)?.[1])
  if (major !== 4) throw Error('Selecione um editor Godot 4.x; esta versão não é suportada.')
  const help = await probe(exe, ['--help'], cwd), capabilities = CAPABILITIES.filter(flag => new RegExp(`(?:^|\\s|,)${flag}(?=\\s|,|$)`, 'm').test(help))
  const missing = CAPABILITIES.filter(c => !capabilities.includes(c))
  if (missing.length) throw Error(`Binário Godot sem recursos do editor necessários: ${missing.join(', ')}.`)
  return { executable: exe, version, major, capabilities }
}
function probe(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cliSpawn(executable, args, { cwd })
    let output = '', failed: Error | null = null
    const stop = (e: Error) => { if (failed) return; failed = e; killTree(child) }
    const timer = setTimeout(() => stop(Error('Tempo limite ao consultar Godot.')), 5000)
    child.stdin?.on('error', () => {}); child.stdin?.end()
    const append = (b: Buffer) => { if (failed) return; if (output.length + b.length > 1024 * 1024) stop(Error('Saída excessiva ao consultar Godot.')); else output += b.toString('utf8') }
    child.stdout?.on('data', append); child.stderr?.on('data', append)
    child.once('error', e => { failed ??= e })
    child.once('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(failed ?? Error(`Godot encerrou a consulta com código ${code}.`)); else resolve(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')) })
  })
}

function resource(cwd: string, value: string, extension: RegExp): string {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw Error('Caminho de recurso inválido.')
  const rel = value.replace(/^res:\/\//, '').replace(/\\/g, '/')
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split('/').includes('..') || rel.split('/').some(p => ['.godot', '.import', '.git', '.worktrees'].includes(p)) || !extension.test(rel)) throw Error('Recurso fora do projeto ou extensão não suportada.')
  const abs = safeJoin(cwd, rel)
  if (!fs.statSync(abs).isFile()) throw Error('Recurso inexistente.')
  return 'res://' + path.relative(fs.realpathSync(cwd), abs).split(path.sep).join('/')
}

// O catálogo captura um arquivo: não declare completo um build que depende de binários externos.
function standaloneExport(cwd: string) {
  let count = 0
  const visit = (dir: string) => {
    if (dir !== cwd && fs.existsSync(path.join(dir, '.gdignore'))) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++count > 20_000) throw Error('Projeto excede 20 mil entradas; não foi possível confirmar uma exportação de arquivo único.')
      if (entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw Error('Projeto contém link de recurso; não foi possível confirmar uma exportação de arquivo único.')
      if (entry.isDirectory()) visit(abs)
      else if (/\.(?:gdextension|cs|csproj|dll|so|dylib)$/i.test(entry.name)) throw Error('Exportação de arquivo único não suporta C# ou extensões/binários nativos. Preserve todos os arquivos pelo exportador Godot.')
    }
  }
  visit(cwd)
}
export function godotCommand(cwd: string, executable: string, action: GodotAction, a: GodotArgs = {}): ProjectCommand {
  if (a.headless !== undefined && typeof a.headless !== 'boolean' || a.debug !== undefined && typeof a.debug !== 'boolean') throw Error('Opções Godot inválidas.')
  const project = godotProject(cwd)
  if (!project.supported) throw Error(project.warnings[0] ?? 'Projeto Godot não suportado.')
  const args = ['--path', '.'], names: Record<GodotAction, string> = { import: 'Godot · Importar recursos', check: 'Godot · Verificar script', run: 'Godot · Executar jogo', editor: 'Godot · Abrir editor', export: 'Godot · Exportar build' }
  let purpose: ProjectCommand['purpose'] = 'run'
  switch (action) {
    case 'import': purpose = 'test'; args.unshift('--headless'); args.push('--import'); break
    case 'check':
      if (!a.script) throw Error('Informe um script .gd; check-only verifica esse script, sem comprovar gameplay.')
      purpose = 'test'; args.unshift('--headless'); args.push('--check-only', '--script', resource(cwd, a.script, /\.gd$/i)); break
    case 'run':
      if (a.headless) args.unshift('--headless')
      if (a.scene) args.push(resource(cwd, a.scene, /\.(tscn|scn)$/i))
      else if (!project.mainScene) throw Error('Configure a cena principal ou informe uma cena para executar.')
      else if (!project.mainScene.startsWith('uid://')) resource(cwd, project.mainScene, /\.(tscn|scn)$/i)
      break
    case 'editor': args.push('--editor'); if (a.scene) args.push(resource(cwd, a.scene, /\.(tscn|scn)$/i)); break
    case 'export': {
      const presets = project.presets.filter(p => p.name === a.preset)
      if (presets.length !== 1) throw Error('Escolha um preset de exportação existente e com nome único.')
      const preset = presets[0]
      if (preset.platform !== 'Windows Desktop') throw Error('Fluxo inicial exporta somente presets Windows Desktop.')
      if (!preset.embeddedPck) throw Error('Ative Embed PCK no preset Godot. PCK externo exige mais de um arquivo e ainda não é suportado neste fluxo.')
      const output = a.output
      if (typeof output !== 'string' || !output.trim() || /[\0\r\n]/.test(output) || path.isAbsolute(output) || /^[a-z]:/i.test(output) || output.replace(/\\/g, '/').split('/').some(p => ['..', '.godot', '.import', '.git', '.worktrees'].includes(p)) || !/\.exe$/i.test(output)) throw Error('Informe um novo .exe em uma pasta de saída dentro do projeto.')
      const abs = safeJoin(cwd, output)
      if (fs.existsSync(abs)) throw Error('Destino já existe; escolha um arquivo novo para preservar o build anterior.')
      if (!fs.existsSync(path.dirname(abs)) || !fs.statSync(path.dirname(abs)).isDirectory()) throw Error('Crie a pasta de saída antes de exportar.')
      if (fs.readdirSync(path.dirname(abs)).length) throw Error('Escolha uma pasta de saída vazia; o Godot pode criar arquivos auxiliares além do .exe.')
      standaloneExport(fs.realpathSync(cwd))
      purpose = 'build'; args.unshift('--headless'); args.push(a.debug ? '--export-debug' : '--export-release', preset.name, path.relative(fs.realpathSync(cwd), abs).split(path.sep).join('/')); break
    }
    default: throw Error('Ação Godot inválida.')
  }
  if (a.log !== undefined && a.log !== '') {
    if (typeof a.log !== 'string' || /[\0\r\n]/.test(a.log) || path.isAbsolute(a.log) || /^[a-z]:/i.test(a.log) || a.log.replace(/\\/g, '/').split('/').some(p => ['..', '.godot', '.import', '.git', '.worktrees'].includes(p)) || !/\.log$/i.test(a.log)) throw Error('Informe um novo arquivo .log relativo dentro do projeto.')
    const log = safeJoin(cwd, a.log)
    if (fs.existsSync(log)) throw Error('Arquivo de log já existe; escolha um arquivo novo.')
    if (!fs.existsSync(path.dirname(log)) || !fs.statSync(path.dirname(log)).isDirectory()) throw Error('Crie a pasta do log antes de executar.')
    args.push('--log-file', path.relative(fs.realpathSync(cwd), log).split(path.sep).join('/'))
  }
  return normalizeCommand({ name: names[action], purpose, program: executable, args })
}

export function godotDiagnostics(output: string): { items: GodotDiagnostic[]; errorCount: number; warningCount: number; totalLines: number } {
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/), raw: GodotDiagnostic[] = []
  let current: GodotDiagnostic | undefined
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim(), hit = text.match(/^(SCRIPT ERROR|ERROR|WARNING):\s*(.*)$/)
    if (hit) { current = { severity: hit[1] === 'WARNING' ? 'warning' : 'error', message: hit[2], count: 1, outputLines: [i + 1] }; raw.push(current); continue }
    const location = text.match(/^(?:at:|\[\d+\]:)\s*(.*)$/)
    if (current && location) {
      current.origin ??= location[1]
      const at = location[1].match(/\(([^()]+):(\d+)\)$/) ?? location[1].match(/^(.+):(\d+)$/)
      if (at && !current.file) { current.file = at[1]; current.line = Number(at[2]) }
      current.outputLines.push(i + 1)
    } else if (text && !/^(?:GDScript backtrace|C\+\+ backtrace|\[\d+\])/.test(text)) current = undefined
  }
  const grouped = new Map<string, GodotDiagnostic>()
  for (const item of raw) {
    const key = JSON.stringify([item.severity, item.message, item.file, item.line, item.origin]), previous = grouped.get(key)
    if (previous) { previous.count++; previous.outputLines.push(...item.outputLines) } else grouped.set(key, item)
  }
  return { items: [...grouped.values()], errorCount: raw.filter(d => d.severity === 'error').length, warningCount: raw.filter(d => d.severity === 'warning').length, totalLines: lines.length }
}

// Receitas Unity (CLI em batchmode) para o fluxo preparado (engineFlow): -projectPath ., um -logFile novo dentro do projeto
// (legível por unity_diagnostics), caminhos relativos validados, saídas novas e o .cs do -executeMethod fixado por hash.
import fs from 'node:fs'
import path from 'node:path'
import { normalizeCommand, type ProjectCommand } from './commands.ts'
import { safeJoin } from './guard.ts'
import { resolveCli } from './providers.ts'
import { MAX_SCAN, unityIndex, unityLog, unityProject, unityTestResults, type UnityDiag, type UnityTests } from './unity.ts'
import type { EngineDiagnostic, EngineProbe, EngineRecipe } from './engineFlow.ts'

export type UnityAction = 'compile' | 'test' | 'build' | 'method' | 'editor'
export type UnityTarget = 'Win64' | 'OSXUniversal' | 'Linux64'
export type UnityArgs = { log?: string; platform?: string; filter?: string; results?: string; target?: string; output?: string; method?: string }
export type UnityDetails = { editor: string | null; pipeline: string; scenes: number; enabledScenes: number; testAssemblies: string[]; warnings: string[] }
// -buildTarget e a opção -build<...>Player correspondente; ext é o que o Unity grava no destino (.app é uma pasta).
export const UNITY_TARGETS: Record<UnityTarget, { flag: string; ext: string }> = { Win64: { flag: '-buildWindows64Player', ext: '.exe' }, OSXUniversal: { flag: '-buildOSXUniversalPlayer', ext: '.app' }, Linux64: { flag: '-buildLinux64Player', ext: '.x86_64' } }
const NAMES: Record<UnityAction, string> = { compile: 'Unity · Importar e compilar', test: 'Unity · Executar testes', build: 'Unity · Gerar build', method: 'Unity · Executar método', editor: 'Unity · Abrir editor' }
// Mesmas pastas que as ferramentas unity_* não leem (saídas ali não seriam diagnosticáveis), comparadas sem caixa.
const INDEX_INTERNAL = ['.git', '.worktrees', 'node_modules', 'Library', 'Temp', 'Logs', 'UserSettings', 'obj']
const INTERNAL = INDEX_INTERNAL.map(s => s.toLowerCase()), SOURCE = ['assets', 'packages', 'projectsettings']
const METHOD = /^(?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*$/
const UNKNOWN = 'versão não identificada'
const posix = (p: string) => p.split(path.sep).join('/')
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const at = (c: ProjectCommand, flag: string) => { const i = c.args.indexOf(flag); return i >= 0 ? c.args[i + 1] : undefined }

// Relativo, dentro do projeto (links resolvidos), sem "..", pastas internas, controle ou "-" inicial (seria lido como opção).
function relPath(cwd: string, value: unknown, what: string): { abs: string; rel: string } {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) throw Error(`Informe ${what}.`)
  const bad = (r: string) => r.startsWith('-') || r.split('/').some(p => p === '..' || INTERNAL.includes(p.toLowerCase())), input = value.replace(/\\/g, '/')
  const refuse = () => { throw Error(`${cap(what)} deve ser relativo ao projeto, sem ".." nem pastas internas (Library, Temp, Logs…).`) }
  if (path.isAbsolute(input) || /^[a-z]:/i.test(input) || bad(input)) refuse()
  const abs = safeJoin(cwd, input), rel = posix(path.relative(fs.realpathSync(cwd), abs))
  if (!rel || bad(rel)) refuse()
  if (SOURCE.includes(rel.split('/')[0].toLowerCase())) throw Error(`${cap(what)} não pode ficar em Assets/, Packages/ ou ProjectSettings/: o Unity importaria ou alteraria o projeto.`)
  return { abs, rel }
}
// Arquivo novo gerado pela execução: pasta existente, arquivo ainda inexistente (preserva resultados anteriores).
function newFile(cwd: string, value: unknown, ext: string, what: string) {
  const p = relPath(cwd, value, what)
  if (!p.rel.toLowerCase().endsWith(ext)) throw Error(`${cap(what)} precisa terminar em ${ext}.`)
  if (!fs.statSync(path.dirname(p.abs), { throwIfNoEntry: false })?.isDirectory()) throw Error(`Crie antes a pasta de destino (${what}).`)
  if (fs.lstatSync(p.abs, { throwIfNoEntry: false })) throw Error(`${cap(what)} já existe; escolha um arquivo novo para preservar o anterior.`)
  return p.rel
}

// .cs em Assets/ (como o Unity importa: sem ".*", "*~" nem links) que declaram a classe e um método static com o nome.
// Varredura sem cache: o conjunto fixado precisa refletir o disco no momento da preparação e do spawn.
export function methodSources(cwd: string, method: string): string[] {
  const parts = method.split('.'), name = parts.pop()!, cls = parts.pop()!, ns = parts.join('\\s*\\.\\s*'), root = fs.realpathSync(cwd), files: string[] = []
  const has = [new RegExp(`\\bclass\\s+${cls}\\b`), new RegExp(`\\bstatic\\b[^;{}()=]*?\\b${name}\\s*\\(`), ...ns ? [new RegExp(`\\bnamespace\\s+${ns}\\s*[{;]`)] : []]
  const visit = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (files.length > 20_000) throw Error('Assets/ tem arquivos demais para localizar o método.')
      if (e.name.startsWith('.') || e.name.endsWith('~') || e.isSymbolicLink()) continue
      if (e.isDirectory()) visit(`${rel}/${e.name}`); else if (e.isFile() && e.name.endsWith('.cs')) files.push(`${rel}/${e.name}`)
    }
  }
  visit('Assets')
  return files.sort().filter(rel => {
    const file = path.join(root, rel), code = fs.statSync(file).size <= 1024 * 1024 && fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    return !!code && has.every(re => re.test(code))
  })
}

export function unityCommand(cwd: string, executable: string, action: string, a: UnityArgs): { command: ProjectCommand; pins: string[] } {
  const batch = ['-batchmode', '-quit', '-nographics', '-projectPath', '.']
  let args: string[], pins: string[] = [], purpose: ProjectCommand['purpose'] = 'test'
  switch (action) {
    case 'compile': args = batch; break
    case 'test': {
      const platform = a.platform ?? 'EditMode'
      if (platform !== 'EditMode' && platform !== 'PlayMode') throw Error('Plataforma de teste: EditMode ou PlayMode.')
      if (a.filter !== undefined && (typeof a.filter !== 'string' || a.filter.length > 500 || /^-|[\x00-\x1f\x7f]/.test(a.filter))) throw Error('Filtro de testes inválido.')
      // -runTests encerra o editor sozinho; -quit junto faria o Unity sair antes de rodar os testes.
      args = [...batch.filter(x => x !== '-quit'), '-runTests', '-testPlatform', platform, ...a.filter ? ['-testFilter', a.filter] : [], '-testResults', newFile(cwd, a.results, '.xml', 'o arquivo de resultados')]; break
    }
    case 'build': {
      const t = typeof a.target === 'string' && Object.hasOwn(UNITY_TARGETS, a.target) ? UNITY_TARGETS[a.target as UnityTarget] : undefined
      if (!t) throw Error('Escolha o alvo do build: Win64, OSXUniversal ou Linux64.')
      const out = relPath(cwd, a.output, 'o destino do build'), dir = path.dirname(out.abs), st = fs.statSync(dir, { throwIfNoEntry: false })
      if (!out.rel.toLowerCase().endsWith(t.ext) || path.posix.basename(out.rel).length <= t.ext.length) throw Error(`O destino do build ${a.target} precisa terminar em ${t.ext}.`)
      // O Unity grava pastas e bibliotecas ao lado do executável: só pasta vazia, ou nova dentro de uma existente.
      if (st ? !st.isDirectory() || fs.readdirSync(dir).length > 0 : !fs.statSync(path.dirname(dir), { throwIfNoEntry: false })?.isDirectory()) throw Error('Use uma pasta de build vazia, ou nova dentro de uma pasta existente: o Unity grava vários arquivos ao lado do executável.')
      args = [...batch, '-buildTarget', a.target as string, t.flag, out.rel]; purpose = 'build'; break
    }
    case 'method': {
      if (typeof a.method !== 'string' || a.method.length > 300 || !METHOD.test(a.method)) throw Error('Informe o método como Namespace.Classe.Metodo (identificadores C#).')
      pins = methodSources(cwd, a.method)
      if (!pins.length) throw Error(`Nenhum .cs em Assets/ declara a classe e um método static "${a.method.split('.').pop()}" para ${a.method}.`)
      args = [...batch, '-executeMethod', a.method]; purpose = 'build'; break
    }
    case 'editor': return { command: normalizeCommand({ name: NAMES.editor, purpose: 'run', program: executable, args: ['-projectPath', '.'] }), pins }
    default: throw Error('Ação Unity inválida.')
  }
  args = [...args, '-logFile', newFile(cwd, a.log, '.log', 'o arquivo de log')]
  return { command: normalizeCommand({ name: NAMES[action as UnityAction], purpose, program: executable, args }), pins }
}

// Arquivos que a execução deve produzir: log, resultados NUnit e o player (.app é pasta: confere o Info.plist).
export function unityOutputs(command: ProjectCommand): string[] {
  const player = Object.values(UNITY_TARGETS).map(t => at(command, t.flag)).find(Boolean)
  return [at(command, '-logFile'), at(command, '-testResults'), player && /\.app$/i.test(player) ? `${player}/Contents/Info.plist` : player].filter((x): x is string => !!x)
}

// Sem --version rápido: a versão sai do layout do Unity Hub ou do Info.plist do .app; o editor nunca é aberto para isso.
export function unityVersionOf(exe: string): string {
  const version = '(\\d+\\.\\d+\\.\\d+[abfpx]\\d+(?:c\\d+)?)'
  for (const p of new Set([exe, (() => { try { return fs.realpathSync.native(exe) } catch { return exe } })()].map(p => p.replace(/\\/g, '/')))) {
    const hub = new RegExp(`/Editor/${version}/(?:Editor/Unity(?:\\.exe)?|Unity\\.app/Contents/MacOS/Unity)$`, 'i').exec(p)?.[1]
    if (hub) return hub
    if (/\/Contents\/MacOS\/Unity$/.test(p)) try {
      const plist = fs.readFileSync(path.join(path.dirname(p), '..', 'Info.plist'), 'utf8')
      const v = /<key>CFBundle(?:Short)?VersionString<\/key>\s*<string>[^<]*?(\d+\.\d+\.\d+[abfpx]\d+(?:c\d+)?)/.exec(plist)?.[1] ?? /<key>CFBundleVersion<\/key>\s*<string>(\d+\.\d+\.\d+[abfpx]\d+(?:c\d+)?)/.exec(plist)?.[1]
      if (v) return v
    } catch {}
  }
  return UNKNOWN
}
export async function unityProbe(executable: string): Promise<EngineProbe> {
  const program = normalizeCommand({ name: 'Unity', purpose: 'run', program: executable, args: [] }).program
  const exe = path.isAbsolute(program) ? program : await resolveCli(program)
  if (!exe || !fs.statSync(exe, { throwIfNoEntry: false })?.isFile()) throw Error(`Executável do Unity não encontrado ("${program}"). Configure no organizador o binário do editor: …/Hub/Editor/<versão>/Editor/Unity(.exe) ou, no macOS, …/Unity.app/Contents/MacOS/Unity.`)
  return { exe, version: unityVersionOf(exe) }
}

// Log (-logFile) e NUnit XML (-testResults) lidos da pasta da execução; sem log, a saída do processo.
function readOut(cwd: string, rel: string | undefined): { text: string; big: boolean } | undefined {
  if (!rel) return undefined
  try {
    const f = safeJoin(cwd, rel), s = fs.lstatSync(f)
    if (!s.isFile()) return undefined
    const fd = fs.openSync(f, 'r'), b = Buffer.alloc(Math.min(s.size, MAX_SCAN))
    try { fs.readSync(fd, b, 0, b.length, 0) } finally { fs.closeSync(fd) }
    return { text: b.toString('utf8'), big: s.size > MAX_SCAN }
  } catch { return undefined }
}
function testResults(command: ProjectCommand, cwd: string): UnityTests | string | undefined {
  const xml = readOut(cwd, at(command, '-testResults'))
  if (!xml) return undefined
  try { return unityTestResults(xml.text) } catch (e) { return `Resultados de teste ilegíveis: ${(e as Error).message}` }
}
export function unityRunDiagnostics(output: string, run?: { command: ProjectCommand; cwd: string }) {
  const log = run && readOut(run.cwd, at(run.command, '-logFile')), parsed = unityLog(log?.text ?? output), tests = run && testResults(run.command, run.cwd)
  const all: UnityDiag[] = [...typeof tests === 'object' ? tests.items : [], ...parsed.items]
  // Avisos de licenciamento aparecem em execuções bem-sucedidas; licença inválida de fato encerra com exit ≠ 0.
  const items: EngineDiagnostic[] = all.map(d => ({ severity: d.kind === 'licença' && d.severity === 'error' ? 'warning' : d.severity, message: `${d.kind}${d.code ? ` ${d.code}` : ''}: ${d.message}`, ...d.file ? { file: d.file } : {}, ...d.line != null ? { line: d.line } : {}, count: d.count }))
  if (typeof tests === 'string') items.unshift({ severity: 'error', message: tests, count: 1 })
  const rank = { error: 0, warning: 1, info: 2 }
  items.sort((a, b) => rank[a.severity] - rank[b.severity])
  const sum = (s: string) => items.filter(i => i.severity === s).reduce((n, i) => n + i.count, 0)
  return { items, errorCount: sum('error'), warningCount: sum('warning'), totalLines: parsed.totalLines }
}
// Antes dos erros genéricos: resumo dos testes (exit 2 ou exit 0 com falhas no XML) e log grande demais para confirmar.
export function unityVerdict(command: ProjectCommand, cwd: string): string | undefined {
  const tests = testResults(command, cwd)
  if (typeof tests === 'string') return tests
  if (tests && (tests.failed > 0 || /^Failed/i.test(tests.result))) {
    const names = tests.items.filter(i => i.severity === 'error').map(i => i.code ?? i.kind)
    return `Testes Unity: ${tests.failed} de ${tests.total} falharam (${tests.passed} passaram, ${tests.skipped} pulados)${names.length ? `: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` e mais ${names.length - 3}` : ''}` : ''}.`
  }
  if (tests && !tests.total) return 'Nenhum teste executado: confira a plataforma, o filtro e os assemblies de teste.'
  if (readOut(cwd, at(command, '-logFile'))?.big) return 'Log Unity maior que 32 MiB: não foi possível confirmar ausência de erros. Consulte o log completo.'
  return undefined
}

export const UNITY_RECIPE: EngineRecipe = {
  actions: ['compile', 'test', 'build', 'method', 'editor'],
  fields: { log: 'string', platform: 'string', filter: 'string', results: 'string', target: 'string', output: 'string', method: 'string' },
  probe: unityProbe,
  build: (cwd, exe, action, args) => unityCommand(cwd, exe, action, args as UnityArgs),
  outputs: unityOutputs,
  diagnostics: unityRunDiagnostics,
  verdict: unityVerdict,
  details: async (cwd): Promise<UnityDetails> => {
    const p = unityProject(rel => fs.readFileSync(safeJoin(cwd, rel), 'utf8'), [...unityIndex(cwd, INDEX_INTERNAL).files.keys()])
    return { editor: p.editor, pipeline: p.pipeline.kind, scenes: p.scenes.length, enabledScenes: p.scenes.filter(s => s.enabled && s.path).length, testAssemblies: p.asmdefs.filter(a => a.test).map(a => a.name), warnings: p.warnings.slice(0, 5) }
  }
}

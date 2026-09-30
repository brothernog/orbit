// Evidencia de testes: comando, cwd, exit code, duracao e saida completa (artefato). O resumo so vem de formatos CONHECIDOS,
// extraidos por regra (nada de LLM); formato desconhecido fica rotulado e recuperavel. Sem dependencia de 'electron'.
//
// Contrato CONSERVADOR de reuso: pular um teste so e recomendado com evidencia `executor_observed` (o proprio dashboard capturou a execucao),
// de sucesso, com dependencias completas e inalteradas (raizes reenumeradas + manifesto de arquivos e hashes + configuracoes/lockfiles),
// comando e cwd IDENTICOS, ambiente comparavel e sem rede. O que o agente apenas RELATA (`agent_reported`) fica consultavel para diagnostico,
// mas nunca dispensa nova execucao. Ainda nao existe captura confiavel ligada a esta ferramenta (o dashboard nao executa comandos de teste
// por conta do agente): por isso, hoje, nenhuma consulta devolve `reusable: true` pelo endpoint do agente.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { saveArtifact } from './artifacts.ts'
import { addMemory, fileEvidence, searchMemory, type EvidenceSource, type FileEvidence, type MemoryRow } from './memory.ts'
import { listFilesUnder } from './workspaceTools.ts'

const MAX_OUTPUT = 1_000_000

export function summarizeTestOutput(out: string): { format: string; summary: string } | null {
  const n = (re: RegExp) => Number(re.exec(out)?.[1])
  let m: RegExpExecArray | null
  if (/^# tests \d+/m.test(out) && /^# pass \d+/m.test(out)) return { format: 'node:test/TAP', summary: `${n(/^# tests (\d+)/m)} testes, ${n(/^# pass (\d+)/m)} passaram, ${n(/^# fail (\d+)/m) || 0} falharam` }
  if ((m = /^ℹ tests (\d+)[\s\S]*?^ℹ pass (\d+)[\s\S]*?^ℹ fail (\d+)/m.exec(out))) return { format: 'node:test', summary: `${m[1]} testes, ${m[2]} passaram, ${m[3]} falharam` }
  if ((m = /^Tests:\s+(.+)$/m.exec(out))) return { format: 'jest/vitest', summary: m[1].trim() }
  if ((m = /=+ (.*?(?:passed|failed|error).*?) in [\d.]+s/i.exec(out))) return { format: 'pytest', summary: m[1].trim() }
  if (/error TS\d+/.test(out)) return { format: 'tsc', summary: `${(out.match(/error TS\d+/g) ?? []).length} erro(s) de tipo` }
  return null
}

export type TestCtx = { taskId: number; lineage: string; grantId: string; cwd: string; owner: 'run' | 'delegation'; originId?: number }
export type RecordTestArgs = { command: string; exitCode: number; output: string; durationMs?: number; inputs?: string[]; hermetic?: boolean; network?: boolean; env?: string }
const bad = (m: string): never => { throw new Error(m) }
const str = (v: unknown, name: string, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v : bad(`${name} obrigatorio (ate ${max} caracteres).`))

// Configuracoes e lockfiles que mudam o resultado de um teste sem estar sob as pastas declaradas. Procurados na RAIZ da area de trabalho.
const CONFIG_NAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', '.npmrc', '.nvmrc', '.node-version', '.tool-versions',
  'pyproject.toml', 'setup.cfg', 'setup.py', 'pytest.ini', 'tox.ini', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'uv.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
  'project.godot', 'global.json', 'Directory.Build.props', 'Directory.Packages.props'
])
const CONFIG_PATTERNS = [/^tsconfig(\..+)?\.json$/i, /^jsconfig\.json$/i, /^requirements.*\.txt$/i, /^(vite|vitest|jest|electron\.vite|eslint|babel)\.config\.[cm]?[jt]s$/i, /^\.eslintrc(\..+)?$/i, /^\.babelrc(\..+)?$/i, /^jest\.config\..+$/i]
export function configFiles(cwd: string): string[] {
  try {
    return fs.readdirSync(cwd, { withFileTypes: true }).filter(e => e.isFile() && (CONFIG_NAMES.has(e.name) || CONFIG_PATTERNS.some(re => re.test(e.name)))).map(e => e.name).sort()
  } catch { return [] }
}

// Manifesto ordenado (caminho + hash de conteudo) das raizes declaradas + configuracoes. Falha de enumeracao vira `error`: cobertura desconhecida.
export function dependencyManifest(cwd: string, roots: string[], configs: string[]): { files: FileEvidence[]; error?: string } {
  try {
    const rels = new Set<string>()
    for (const r of roots) for (const f of listFilesUnder({ cwd }, r)) rels.add(f)
    for (const c of configs) rels.add(c)
    const files = fileEvidence(cwd, [...rels].sort()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { files }
  } catch (e: any) { return { files: [], error: String(e?.message ?? e).slice(0, 300) } }
}
const realCwd = (cwd: string) => { try { return fs.realpathSync(cwd) } catch { return path.resolve(cwd) } }
const sameCwd = (a: string, b: string) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))

// `source` NUNCA vem do agente: o endpoint chamado por ele passa 'agent_reported' (ver taskContext.ts). 'executor_observed' so por um caminho
// do proprio backend que capture a execucao (nao ha nenhum ligado ainda; ver o cabecalho).
export function recordTestEvidence(db: DatabaseSync, c: TestCtx, a: RecordTestArgs, source: EvidenceSource = 'agent_reported') {
  const command = str(a.command, 'command', 500).trim()
  if (!Number.isInteger(a.exitCode)) bad('exitCode deve ser inteiro.')
  if (typeof a.output !== 'string' || a.output.length > MAX_OUTPUT) bad(`output obrigatorio (ate ${MAX_OUTPUT} caracteres).`)
  const inputs = a.inputs ?? []
  if (!Array.isArray(inputs) || inputs.length > 50 || inputs.some(p => typeof p !== 'string')) bad('inputs: ate 50 caminhos.')
  const roots = [...new Set(inputs.map(p => p.trim()).filter(Boolean))]
  const configs = configFiles(c.cwd)
  // A evidencia de teste (inclusive de falha) e sempre guardada; se as dependencias nao puderem ser enumeradas, ela vale so como diagnostico.
  const manifest = dependencyManifest(c.cwd, roots, configs)
  const depsComplete = !manifest.error && roots.length > 0
  const depsNote = manifest.error ?? (roots.length ? undefined : 'nenhuma dependencia declarada')
  const art = saveArtifact(db, { taskId: c.taskId, producer: c.lineage, readers: [c.grantId], kind: 'test-output', title: command.slice(0, 120), content: a.output, meta: { exitCode: a.exitCode, source } })
  const known = summarizeTestOutput(a.output)
  const summary = known ? `${known.format}: ${known.summary}` : 'formato de saida desconhecido: sem resumo automatico (leia a saida completa no artefato)'
  const test = {
    command, cwd: realCwd(c.cwd), exitCode: a.exitCode, durationMs: a.durationMs, hermetic: a.hermetic === true, network: a.network === true, env: a.env?.slice(0, 200) ?? null, summary,
    source, roots, configs, depsComplete, ...(depsNote ? { depsNote } : {})
  }
  const who = source === 'executor_observed' ? 'execucao observada pelo dashboard' : 'RELATO do agente (o dashboard so recebeu o texto; nao observou a execucao)'
  const mem = addMemory(db, {
    taskId: c.taskId, owner: c.owner, originId: c.originId, lineage: c.lineage, grantId: c.grantId, kind: 'validation', title: `Teste: ${command.slice(0, 150)}`,
    content: `Comando: ${command}\nexit code: ${a.exitCode}${a.durationMs !== undefined ? `\nduracao: ${a.durationMs} ms` : ''}\nresumo: ${summary}\nfonte: ${who}\nsaida completa: artefato #${art.id}\nhermetico: ${test.hermetic ? 'sim' : 'nao declarado'}; rede: ${test.network ? 'sim' : 'nao declarado'}; dependencias: ${depsComplete ? `${manifest.files.length} arquivo(s)` : `INCOMPLETAS (${depsNote})`}`,
    evidence: { files: manifest.error ? [] : manifest.files, artifacts: [art.id], test }
  })
  return { memoryId: mem.id, artifactId: art.id, summary, source, dependencies: manifest.files.length, ...(depsComplete ? {} : { note: `dependencias incompletas: ${depsNote}; esta evidencia serve so como diagnostico` }) }
}

export type LookupResult = {
  reusable: boolean; reason: string; memoryId?: number; exitCode?: number; summary?: string; artifactId?: number
  evidenceSource?: EvidenceSource | 'unknown'; dependenciesUnchanged?: boolean // informativo: NAO autoriza pular o teste
}
export function lookupTestEvidence(db: DatabaseSync, c: TestCtx, a: { command: string; env?: string }): LookupResult {
  const want = str(a.command, 'command', 500).trim() // comparacao EXATA: caixa, acentos e espacos internos dos argumentos importam
  const cwd = realCwd(c.cwd)
  const cand = searchMemory(db, { taskId: c.taskId, lineages: [c.lineage], grantId: c.grantId, kind: 'validation', limit: 1000 }).items
    .filter(m => m.evidence.test && m.evidence.test.command === want && sameCwd(m.evidence.test.cwd, cwd)).at(-1) as MemoryRow | undefined
  if (!cand) return { reusable: false, reason: 'nenhuma evidencia registrada para este comando exato neste diretorio: execute o teste.' }
  const t = cand.evidence.test!
  const source: EvidenceSource | 'unknown' = t.source ?? 'unknown'
  const base = { memoryId: cand.id, exitCode: t.exitCode, summary: t.summary, artifactId: cand.evidence.artifacts?.[0], evidenceSource: source }
  const no = (reason: string, extra: Partial<LookupResult> = {}): LookupResult => ({ ...base, ...extra, reusable: false, reason })
  if (source === 'unknown' || !t.roots || !t.configs) return no('registro legado (sem fonte nem manifesto de dependencias): validade desconhecida, reexecute.')
  // Dependencias: reenumera as MESMAS raizes e configuracoes; adicao, remocao, renomeacao ou mudanca de conteudo invalidam.
  const before = (cand.evidence.files ?? []) as FileEvidence[]
  const configsNow = configFiles(c.cwd)
  const now = dependencyManifest(c.cwd, t.roots, [...new Set([...t.configs, ...configsNow])])
  let unchanged = false, depsWhy = ''
  if (now.error) depsWhy = `dependencias nao puderam ser reenumeradas (${now.error})`
  else {
    const was = new Map(before.map(f => [f.path, f.hash])), is = new Map(now.files.map(f => [f.path, f.hash]))
    const added = [...is.keys()].filter(p => !was.has(p)), removed = [...was.keys()].filter(p => !is.has(p)), changed = [...is.keys()].filter(p => was.has(p) && was.get(p) !== is.get(p))
    unchanged = !added.length && !removed.length && !changed.length && !(t.configs.length !== configsNow.length || t.configs.some((f, i) => f !== configsNow[i]))
    if (!unchanged) depsWhy = `dependencias mudaram (${[...added.map(p => `+${p}`), ...removed.map(p => `-${p}`), ...changed.map(p => `~${p}`)].slice(0, 5).join(', ') || 'configuracoes/lockfiles'})`
  }
  const info: Partial<LookupResult> = { dependenciesUnchanged: unchanged }
  if (source !== 'executor_observed')
    return no(`evidencia apenas RELATADA pelo agente (agent_reported): fica consultavel para diagnostico, mas nao autoriza pular o teste; reexecute.${unchanged ? ' As dependencias seguem iguais ao momento do relato.' : ` ${depsWhy}.`}`, info)
  if (t.exitCode !== 0) return no('a ultima execucao FALHOU: evidencia de falha serve para diagnostico e nunca dispensa nova execucao.', info)
  if (!t.depsComplete || !t.roots.length) return no(`sem cobertura completa das dependencias (${t.depsNote ?? 'nao declaradas'}): validade desconhecida, reexecute.`, info)
  if (!t.hermetic || t.network) return no('teste de rede/externo ou nao declarado como hermetico: nunca e reutilizado automaticamente; reexecute.', info)
  if (!t.env || !a.env || t.env !== a.env) return no('ambiente nao informado ou diferente do registrado: reexecute.', info)
  if (!unchanged) return no(`${depsWhy}: reexecute.`, info)
  return { ...base, reusable: true, dependenciesUnchanged: true, reason: 'execucao observada pelo dashboard, com sucesso; comando, diretorio, dependencias (manifesto e configuracoes/lockfiles) e ambiente identicos.' }
}

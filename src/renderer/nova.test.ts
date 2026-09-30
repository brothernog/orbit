import test from 'node:test'
import assert from 'node:assert/strict'
import { digest } from './nova.ts'

const git = (o: Partial<{ branch: string; ahead: number; behind: number; files: unknown[] }> = {}) => ({ branch: 'main', ahead: 0, behind: 0, files: [], ...o })
const base = { name: (g: string) => g.split('/').pop()!, label: (p: string) => p.toUpperCase(), now: 10 * 60000 }

test('nova: espera voce primeiro, depois agentes e Git; so as pastas do escopo', () => {
  const d = digest({
    ...base, games: ['C:/a', 'C:/b'],
    info: { 'C:/a': { repo: true, git: git({ ahead: 2, files: [1, 2] }), worktrees: [{ ...git({ ahead: 1, files: [1] }), task: 't' }] }, 'C:/b': { repo: false, git: null, worktrees: [] } },
    active: [{ taskId: 7, game: 'c:/B', title: 'Bug', provider: 'claude', startedAt: 0 }, { taskId: 8, game: 'C:/fora', title: 'X', provider: 'codex', startedAt: 0 }],
    waiting: [{ id: 3, game: 'C:/a', title: 'Tarefa', why: 'Aprovar contexto' }],
  })
  assert.deepEqual(d.items.map(i => [i.tone, i.text]), [
    ['wait', '"Tarefa" espera você'], ['live', 'CLAUDE em "Bug"'], ['push', '3 commits para enviar'], ['dirty', '3 arquivos sem commit'],
  ])
  assert.equal(d.items[1].meta, 'b · há 10 min')
  assert.equal(d.headline, '1 coisa espera por você.')
})

test('nova: frase de cima segue o que mais importa', () => {
  const one = (info: any, active: any[] = []) => digest({ ...base, games: ['C:/a'], info: { 'C:/a': info }, active, waiting: [] }).headline
  assert.equal(one({ repo: true, git: git(), worktrees: [] }), 'Tudo em dia. Nada pede você agora.')
  assert.match(one({ repo: true, git: git({ behind: 1 }), worktrees: [] }), /Falta fechar/)
  assert.match(one({ repo: true, git: git(), worktrees: [] }, [{ taskId: 1, game: 'C:/a', title: 't', provider: 'x', startedAt: 0 }]), /^1 agente trabalhando/)
})

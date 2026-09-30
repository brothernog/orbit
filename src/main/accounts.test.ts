import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { migrate } from './db.ts'
import { createAccounts } from './accounts.ts'

test('contas: pasta efetiva, colisao de login e conta inexistente', async () => {
  const db = new DatabaseSync(':memory:'); migrate(db)
  const dir = path.join(os.tmpdir(), 'orbit-accounts-test')
  db.prepare('INSERT INTO accounts (name, config_dir) VALUES (?, NULL), (?, ?), (?, ?)').run('a', 'b', dir, 'c', dir.toUpperCase())
  const acc = createAccounts(db)
  const [a, b, c] = acc.listAccounts()
  assert.equal(acc.dirKey(a), path.resolve(path.join(os.homedir(), '.claude')).toLowerCase())
  assert.equal(a.collision, false)
  assert.equal(b.collision, true) // mesma pasta com outra caixa: mesmo login
  assert.equal(c.collision, true)
  assert.equal(acc.accountRow(null), null)
  assert.equal(acc.accountRow(b.id).name, 'b')
  await assert.rejects(acc.fetchUsage(999, new AbortController().signal), /Conta inexistente/)
})

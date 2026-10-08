import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contextHandlers } from './contextIpc.ts'

test('taskImage: preview uses the image already authorized for the task; normal chat keeps the original', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-images-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'project'), attachments = path.join(root, 'attachments')
  fs.mkdirSync(workspace)
  fs.mkdirSync(path.join(attachments, '1'), { recursive: true })
  fs.mkdirSync(path.join(attachments, '2'), { recursive: true })
  const image = path.join(workspace, 'asset.png'), own = path.join(attachments, '1', 'own.png'), other = path.join(attachments, '2', 'other.png')
  for (const file of [image, own, other]) fs.writeFileSync(file, Buffer.from('aW1hZ2U=', 'base64'))
  const seen: string[] = []
  const h = contextHandlers({
    asTask: () => ({ id: 1 }), taskCwd: async () => workspace, attachRoot: attachments,
    imagePreview: (data: string) => { seen.push(data); return 'data:image/jpeg;base64,cHJldmlldw==' }
  } as any)
  const original = await h.taskImage(1, image)
  assert.match(original!, /^data:image\/png;base64,/)
  assert.deepEqual(seen, [])
  assert.equal(await h.taskImage(1, image, true), 'data:image/jpeg;base64,cHJldmlldw==')
  assert.deepEqual(seen, [original])
  assert.equal(await h.taskImage(1, own, true), 'data:image/jpeg;base64,cHJldmlldw==')
  assert.equal(await h.taskImage(1, other, true), null)
  assert.equal(seen.length, 2)
})

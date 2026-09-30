import assert from 'node:assert/strict'
import test from 'node:test'
import { expand, fold } from './linkedinText.ts'

test('linkedin: comando rapido vira pedido completo; complemento entra no fim; texto livre passa intacto', () => {
  assert.equal(expand('/post'), 'Escreva 2 rascunhos de post novos.')
  assert.equal(expand('/POST sobre o modo coop'), 'Escreva 2 rascunhos de post novos sobre o modo coop')
  assert.equal(expand('/inexistente x'), '/inexistente x')
  assert.equal(expand('oi /post'), 'oi /post')
})

test('linkedin: corte do "ver mais" em 3 linhas ou ~210 caracteres, sem quebrar palavra; post curto nao corta', () => {
  assert.equal(fold('Curto.'), null)
  assert.equal(fold('a\nb\nc\nd'), 'a\nb\nc')
  const long = 'palavra '.repeat(40)
  const cut = fold(long)!
  assert.ok(cut.length <= 210 && cut.endsWith('palavra'))
})

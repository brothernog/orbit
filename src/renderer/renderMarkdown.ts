import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Caixas de tarefa viram texto (o sanitizador nao mantem <input type=checkbox>) e nenhum <input> passa.
marked.use({
  renderer: {
    checkbox: ({ checked }: { checked: boolean }) =>
      `<span class="cb" role="img" aria-label="${checked ? 'feito' : 'pendente'}">${checked ? '☑' : '☐'}</span> `
  }
})

// O texto vem de arquivos do projeto e de respostas de agentes: e sempre sanitizado antes de virar HTML.
// Links: so http/https/mailto/ancora (o main abre no navegador do sistema). Sem imagens remotas, estilos ou formularios.
const SANITIZE = {
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math'],
  FORBID_ATTR: ['style']
}
export const renderMarkdown = (text: string) => DOMPurify.sanitize(marked.parse(text) as string, SANITIZE) as string

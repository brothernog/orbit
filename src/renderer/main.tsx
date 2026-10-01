import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
// Folhas globais antes dos componentes: o CSS de cada componente entra depois e vence as regras globais de mesma especificidade.
import './styles.css'
import './tokens.css'
import './chat.css'
import './settings.css'
import './home.css'
import './project.css'
import './context.css'
import './orbita.css'
import './nova.css'
import App from './App'
import { Planet } from './Planet'

// Um painel que quebra nao apaga a janela inteira (React desmonta a raiz em erro nao capturado).
class Guard extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { err: String((e as Error)?.message ?? e) } }
  componentDidCatch(e: unknown) { console.error(e) }
  render() {
    if (this.state.err == null) return this.props.children
    return <div className="empty" role="alert"><h1>Algo quebrou nesta tela</h1><p>{this.state.err}</p><button onClick={() => location.reload()}>Recarregar</button></div>
  }
}

// A mesma pagina serve o planeta do canto da tela, que tambem vira o aviso (#planet, ver noticeWindow em src/main/index.ts).
const planet = location.hash === '#planet'
if (planet) document.documentElement.classList.add('planet-root')
createRoot(document.getElementById('root')!).render(<Guard>{planet ? <Planet /> : <App />}</Guard>)

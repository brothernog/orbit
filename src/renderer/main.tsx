import { createRoot } from 'react-dom/client'
import App from './App'
import { Planet } from './Planet'
import './styles.css'
import './home.css'
import './project.css'
import './context.css'
import './orbita.css'
import './nova.css'

// A mesma pagina serve o planeta do canto da tela, que tambem vira o aviso (#planet, ver noticeWindow em src/main/index.ts).
const planet = location.hash === '#planet'
if (planet) document.documentElement.classList.add('planet-root')
createRoot(document.getElementById('root')!).render(planet ? <Planet /> : <App />)

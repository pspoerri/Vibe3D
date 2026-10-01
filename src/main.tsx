import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { restoreHash } from './llm/auth'
import './index.css'

restoreHash()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

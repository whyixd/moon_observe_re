import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Preview3DApp } from './Preview3DApp'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview3DApp />
  </StrictMode>,
)

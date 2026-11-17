import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

// API Key 现在只保存在服务端；清掉旧版本留在浏览器里的 Key
try {
  localStorage.removeItem('chat-demo:api-key')
} catch {
  // 存储不可用时忽略
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)

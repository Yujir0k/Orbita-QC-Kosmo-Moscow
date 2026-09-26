import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react(), {
  name: 'server-dataset',
  enforce: 'pre',
  resolveId(source) { if (source.endsWith('/demo-data.json')) return decodeURIComponent(new URL('./src/runtime-dataset.ts', import.meta.url).pathname).replace(/^\/(\w:)/, '$1'); },
}], server: { proxy: { '/api': { target: process.env.ORBITA_DEV_API_URL || 'http://127.0.0.1:5174', changeOrigin: true } } } })

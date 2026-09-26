import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()], server: { proxy: { '/api': { target: process.env.ORBITA_DEV_API_URL || 'http://127.0.0.1:5174', changeOrigin: true } } } })

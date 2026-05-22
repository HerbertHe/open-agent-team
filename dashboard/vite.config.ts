import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  
  let target = env.VITE_ORCHESTRATOR_TARGET
  if (!target) {
    try {
      const statePath = path.resolve(__dirname, '../__test__/niu-ma/.oat/state/orchestrator.json')
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        if (state.orchestratorPort) {
          target = `http://127.0.0.1:${state.orchestratorPort}`
        }
      }
    } catch {
      // ignore
    }
  }
  if (!target) {
    target = 'http://127.0.0.1:8787'
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/observability': {
          target,
          changeOrigin: true,
        },
        '/tool': {
          target,
          changeOrigin: true,
        },
        '/api': {
          target,
          changeOrigin: true,
        },
      },
    },
    build: {
      /** G6 / antd 压缩后仍常 > 500kB，在已做 manualChunks + lazy 的前提下放宽告警阈值 */
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('@antv')) return 'vendor-antv';
            if (id.includes('antd') || id.includes('@ant-design')) return 'vendor-antd';
            if (id.includes('@rc-')) return 'vendor-rc';
            if (id.includes('react-dom')) return 'vendor-react';
            if (id.includes('/react/') || id.endsWith('/react')) return 'vendor-react';
          },
        },
      },
    },
  }
})

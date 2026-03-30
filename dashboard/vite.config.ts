import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_ORCHESTRATOR_TARGET ?? 'http://127.0.0.1:8787'
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/observability': {
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

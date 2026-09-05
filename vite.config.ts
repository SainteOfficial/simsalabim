import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Baut die Extension nach extension/dist/.
 *
 * MV3 verbietet unsafe-eval, deshalb gibt es keinen Dev-Server mit HMR -
 * fuer die Entwicklung laeuft `npm run dev` als Watch-Build.
 * Die Bundles sind bewusst je ein IIFE ohne Code-Splitting: ein Content-Script
 * kann keine Chunks nachladen, und der Service Worker soll ohne Importe starten.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'extension/src') }
  },
  build: {
    outDir: 'extension/dist',
    emptyOutDir: true,
    target: 'chrome116',
    minify: "esbuild",
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        content: resolve(__dirname, 'extension/src/content/main.tsx'),
        background: resolve(__dirname, 'extension/src/background.js')
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: '[name][extname]',
        // Ein Content-Script laedt keine Chunks nach: alles in eine Datei.
        manualChunks: undefined,
        inlineDynamicImports: false
      }
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  }
});

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const targetBrowser = process.env.TARGET_BROWSER || 'chrome'
const outDir = process.env.OUT_DIR || (targetBrowser === 'firefox' ? 'dist/firefox' : 'dist/chrome')

// Side panel startup must depend on as few asset fetches as possible:
// inline the single stylesheet into index.html (MV3 CSP forbids inlining
// JS, so the script tag stays external).
const inlineStyles = (outputDir) => ({
  name: 'inline-styles',
  enforce: 'post',
  closeBundle() {
    const dir = join(import.meta.dirname, outputDir)
    const htmlPath = join(dir, 'index.html')
    let html = readFileSync(htmlPath, 'utf8')
    const link = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/)
    if (link) {
      const cssFile = link[1].replace(/^[./]+/, '')
      const css = readFileSync(join(dir, cssFile), 'utf8')
      html = html.replace(link[0], `<style>${css}</style>`)
      rmSync(join(dir, cssFile))
      writeFileSync(htmlPath, html)
    }
  }
})

const extensionManifest = (target, outputDir) => ({
  name: 'extension-manifest',
  enforce: 'post',
  closeBundle() {
    const dir = join(import.meta.dirname, outputDir)
    if (target === 'firefox') {
      const ffManifestPath = join(import.meta.dirname, 'manifests', 'manifest.firefox.json')
      const targetManifestPath = join(dir, 'manifest.json')
      copyFileSync(ffManifestPath, targetManifestPath)
    }
  }
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), inlineStyles(outDir), extensionManifest(targetBrowser, outDir)],
  base: './', // CRITICAL for extensions
  build: {
    outDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: join(import.meta.dirname, 'index.html'),
        background: join(import.meta.dirname, 'src/background/index.js')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          return 'assets/[name]-[hash].js';
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.js']
  }
})

import preact from '@preact/preset-vite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const outputDirectory = resolve(import.meta.dirname, '../internal/serveui/static/dist');
const priorOutputs = ['asset-manifest.json', 'hub.js', 'hub.css'];

function outputExists(file: string): boolean {
  const path = resolve(outputDirectory, file);
  return existsSync(path) || existsSync(`${path}.gz`);
}

function standaloneManager(): Plugin {
  return {
    name: 'term-llm-standalone-personal-bot',
    buildStart() {
      for (const file of priorOutputs) {
        if (!outputExists(file)) throw new Error(`Personal Bot build requires dist/${file}`);
      }
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
      if (chunks.length !== 1 || chunks[0]?.fileName !== 'personal-bot.js') {
        throw new Error('Personal Bot must build as exactly one standalone JavaScript entry.');
      }
    },
    writeBundle(_options, bundle) {
      const assets = Object.values(bundle).filter((output) => output.type === 'asset');
      if (assets.length !== 1 || assets[0]?.fileName !== 'personal-bot.css') {
        throw new Error('Personal Bot must emit exactly personal-bot.js and personal-bot.css.');
      }
      for (const file of [...priorOutputs, 'personal-bot.js', 'personal-bot.css']) {
        if (!outputExists(file)) throw new Error(`Frontend build did not produce dist/${file}`);
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [standaloneManager(), preact()],
  publicDir: false,
  build: {
    outDir: outputDirectory,
    emptyOutDir: false,
    manifest: false,
    sourcemap: false,
    assetsInlineLimit: 0,
    minify: 'esbuild',
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/hub/personal-bot-main.tsx'),
      output: {
        entryFileNames: 'personal-bot.js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? 'personal-bot.css'
            : 'personal-bot-[name][extname]',
        codeSplitting: false,
      },
    },
  },
});

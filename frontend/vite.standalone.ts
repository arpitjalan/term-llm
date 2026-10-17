import preact from '@preact/preset-vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';

const outputDirectory = resolve(import.meta.dirname, '../internal/serveui/static/dist');

// Compression replaces text outputs with .gz files. Both forms are valid when
// rebuilding a standalone entry after a complete frontend build.
function outputExists(file: string): boolean {
  const path = resolve(outputDirectory, file);
  return existsSync(path) || existsSync(`${path}.gz`);
}

function chatOutputs(): string[] {
  const path = resolve(outputDirectory, 'asset-manifest.json');
  const data = existsSync(path) ? readFileSync(path) : gunzipSync(readFileSync(`${path}.gz`));
  const entry = JSON.parse(data.toString('utf8'))['src/main.tsx'];
  if (!entry?.isEntry || !entry.css?.length)
    throw new Error('Chat asset manifest has no entry/CSS');
  return [entry.file, ...entry.css];
}

/** Hub surfaces share one standalone JS/CSS contract and preserve prior builds. */
export function standaloneHubConfig(name: 'hub' | 'personal-bot') {
  const label = name === 'hub' ? 'Hub' : 'Personal Bot';
  const priorOutputs = () => [
    ...chatOutputs(),
    ...(name === 'personal-bot' ? ['hub.js', 'hub.css'] : []),
  ];
  const contract: Plugin = {
    name: `term-llm-standalone-${name}`,
    buildStart() {
      for (const file of priorOutputs()) {
        if (!outputExists(file)) throw new Error(`${label} build requires dist/${file}`);
      }
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
      if (chunks.length !== 1 || chunks[0]?.fileName !== `${name}.js`)
        throw new Error(`${label} must build as exactly one standalone JavaScript entry.`);
    },
    writeBundle(_options, bundle) {
      const assets = Object.values(bundle).filter((output) => output.type === 'asset');
      if (assets.length !== 1 || assets[0]?.fileName !== `${name}.css`)
        throw new Error(`${label} must emit exactly ${name}.js and ${name}.css.`);
      for (const file of [...priorOutputs(), `${name}.js`, `${name}.css`]) {
        if (!outputExists(file)) throw new Error(`Frontend build did not produce dist/${file}`);
      }
    },
  };
  return defineConfig({
    base: './',
    plugins: [contract, preact()],
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
        input: resolve(
          import.meta.dirname,
          'src/hub',
          name === 'hub' ? 'main.tsx' : 'personal-bot-main.tsx',
        ),
        output: {
          entryFileNames: `${name}.js`,
          assetFileNames: (asset) =>
            asset.names.some((assetName) => assetName.endsWith('.css'))
              ? `${name}.css`
              : `${name}-[name][extname]`,
          // Rolldown prevents splitting; the bundle assertion also fails closed
          // if future graph changes introduce another JavaScript entry.
          codeSplitting: false,
        },
      },
    },
  });
}

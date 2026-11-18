import { defineConfig, normalizePath } from 'vite';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const base = '/garage_stock/';

function browserSettings() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  let url;
  try { url = new URL(process.env.SUPABASE_URL); } catch { /* Report a public configuration error below. */ }
  if (!url || url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash
      || url.username || url.password || !key) {
    throw new Error('Set SUPABASE_URL to an HTTPS origin and provide a public Supabase key.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    let claims;
    const parts = key.split('.');
    if (parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
      try { claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { /* Invalid public key. */ }
    }
    if (claims?.role !== 'anon') throw new Error('Only a public publishable key or anon JWT may be deployed.');
  }
  return { url: url.origin, key };
}

export default defineConfig(({ isPreview }) => {
  const settings = isPreview ? null : browserSettings();
  const dependencyRoot = normalizePath(realpathSync('node_modules')) + '/';
  return {
    base,
    envDir: false,
    envPrefix: [],
    publicDir: false,
    define: settings ? {
      __GARAGE_SUPABASE_URL__: JSON.stringify(settings.url),
      __GARAGE_PUBLIC_KEY__: JSON.stringify(settings.key),
    } : {},
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    plugins: [{
      name: 'garage-public-sources',
      apply: 'build',
      enforce: 'pre',
      load(id) {
        const file = id.split('?')[0];
        if (!path.isAbsolute(file)) return;
        const relative = normalizePath(path.relative(process.cwd(), file));
        if (normalizePath(file).startsWith(dependencyRoot)
            || /^src\/[\w./-]+\.(?:js|ts|tsx|css|woff2)$/.test(relative)
            || /^(?:index|account)\.html$/.test(relative)
            || /^(?:styles|ledger)\.css$/.test(relative)
            || relative === 'manifest.webmanifest'
            || /^icons\/icon-(?:192|512)\.png$/.test(relative)) return;
        this.error('A module outside the public frontend source set was imported: ' + relative);
      },
    }, {
      name: 'garage-browser-client',
      apply: 'build',
      enforce: 'pre',
      resolveId(source, importer) {
        // Keep one public SDK instance for both entries, with a stable browser import.
        // The test HTTP server can then substitute this module without a production hook.
        if (importer && source === './supabase.js') {
          return { id: base + 'sdk.js', external: 'absolute' };
        }
      },
    }],
    build: {
      target: 'es2022',
      assetsInlineLimit: 0,
      manifest: true,
      rollupOptions: {
        input: { app: 'index.html', account: 'account.html', sdk: 'src/supabase.js' },
        preserveEntrySignatures: 'strict',
        output: {
          entryFileNames: chunk => chunk.name === 'sdk' ? 'sdk.js' : 'assets/[name]-[hash].js',
          assetFileNames(asset) {
            const name = asset.names[0];
            if (name === 'manifest.webmanifest') return name;
            if (/^icon-(192|512)\.png$/.test(name)) return 'icons/[name][extname]';
            return 'assets/[name]-[hash][extname]';
          },
        },
      },
    },
  };
});

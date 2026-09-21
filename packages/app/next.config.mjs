import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDevPlatform } from '@cloudflare/next-on-pages/next-dev';

// Load the workspace-root .env.local so the monorepo has a single source
// of truth for secrets. Next.js by default only looks in the package
// directory, so we read the file here at config-load time and inject any
// vars that aren't already set in the process env.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.resolve(__dirname, '../../.env.local');
if (fs.existsSync(rootEnvPath)) {
  for (const line of fs.readFileSync(rootEnvPath, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[2].length > 0 && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
}

// `next dev` gets the D1 and R2 bindings from wrangler.jsonc (local
// simulations under packages/app/.wrangler/state, the same store
// `wrangler d1 migrations apply htmlradar --local` writes), so
// getRequestContext().env works the same in development as on Pages.
if (process.env.NODE_ENV === 'development') {
  await setupDevPlatform();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // @htmlradar/db ships TypeScript source with NodeNext-style `.js` imports.
  transpilePackages: ['@htmlradar/db'],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  experimental: {
    externalDir: true,
    // Body-size ceiling for ALL Server Actions: HTML uploads up to 30 MB,
    // attachment batches of 25 MB files.
    serverActions: { bodySizeLimit: '30mb' },
  },
  // The bare /dashboard was the removed cross-document overview; the
  // per-share /dashboard/:slug is live and deliberately not redirected.
  async redirects() {
    return [{ source: '/dashboard', destination: '/docs', permanent: false }];
  },
};

export default nextConfig;

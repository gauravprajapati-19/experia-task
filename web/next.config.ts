import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';
import path from 'node:path';

// one .env for the whole repo: the API, scripts and this app all read the root file
loadEnv({ path: path.resolve(process.cwd(), '../.env'), quiet: true });

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // the monorepo root; stops Next guessing from stray lockfiles in parent folders
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  env: {
    // lets the "Use demo account" buttons fill the synthetic demo password in development only.
    // A production build never contains it; there the buttons fill the email alone.
    DEMO_PASSWORD: process.env.NODE_ENV === 'production' ? '' : (process.env.SEED_DEMO_PASSWORD ?? ''),
  },
  // same-origin proxy: the browser only ever talks to this app, so the API's httpOnly
  // `session` cookie works without exposing a token to JavaScript.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;

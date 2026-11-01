/** @type {import('next').NextConfig} */
const API = process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000';

export default {
  output: 'standalone',
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true }, // linted from the repo root
  // Same-origin API access: the browser only talks to the web origin, so the session cookie
  // is first-party and the API never needs CORS.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

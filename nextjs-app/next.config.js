/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow the dev server's HMR/_next chunks to load when the app is reached from
  // another device on the LAN (e.g. a phone at http://192.168.1.23:3000) or
  // through an ngrok tunnel. Without this, Next 15+ blocks cross-origin dev
  // resources and the app never hydrates ("loading" forever). Wildcards cover the
  // whole 192.168.1.x subnet AND any ngrok subdomain — the free ngrok host is
  // randomized on each restart (e.g. cool-sincerely-lioness.ngrok-free.app), so a
  // wildcard is required or access breaks every time the tunnel restarts.
  allowedDevOrigins: [
    '192.168.1.23',
    '192.168.1.*',
    '*.ngrok-free.app',
    '*.ngrok.app',
    '*.ngrok.io',
    '*.ngrok-free.dev',
  ],
  // Hide the floating dev-build "N" badge — on phones it sits right over the
  // message input. (Dev-only indicator; has no effect on the app itself.)
  devIndicators: false,
  serverExternalPackages: ['@prisma/client', 'pdfkit', 'sharp'],
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
      },
      {
        protocol: 'http',
        hostname: '127.0.0.1',
      },
    ],
  },
}

module.exports = nextConfig

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow the dev server's HMR/_next chunks to load when the app is reached from
  // another device on the LAN (e.g. a phone) or through OUR ngrok tunnel. Without
  // this, Next 16 blocks cross-origin dev resources and the app never hydrates
  // ("loading" forever). The 192.168.1.* wildcard is fine (private LAN only). The
  // ngrok host is pinned to our ONE stable reserved domain — NOT a *.ngrok-free.app
  // wildcard — so no other random ngrok app can reach the dev HMR resources.
  allowedDevOrigins: [
    '192.168.1.*',
    'cool-sincerely-lioness.ngrok-free.app',
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow the dev server's HMR/_next chunks to load when the app is reached from
  // another device on the LAN (e.g. a phone at http://192.168.1.23:3000).
  // Without this, Next 15+ blocks cross-origin dev resources and the app never
  // hydrates ("loading" forever). The wildcard covers the whole 192.168.1.x
  // subnet so it keeps working if a device's IP changes.
  allowedDevOrigins: ['192.168.1.23', '192.168.1.*'],
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

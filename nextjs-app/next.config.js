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
  // Keep sibling services and the trace corpus out of output file tracing —
  // they are separate processes, not part of the Next app, and together they
  // are hundreds of MB.
  //
  // Related: `next build` used to fail outright with
  //   Symlink services/*/venv/bin/python is invalid, it points out of the
  //   filesystem root
  // Turbopack walks the project directory while resolving skill-registry.ts's
  // runtime imports, and a stock venv leaves "bin/python3 -> /usr/bin/python3"
  // in the tree. Fixed at the source: both venvs now hold a real interpreter
  // binary (python -m venv --copies) rather than a symlink out of the project,
  // and both setup.sh scripts pass --copies so it stays that way. These
  // excludes are a size optimisation, not the fix.
  outputFileTracingExcludes: {
    '*': [
      './services/**',
      './data/traces/**',
      './skill_builder/**',
    ],
  },
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

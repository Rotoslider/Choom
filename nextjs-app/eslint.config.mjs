// ESLint 9 flat config. Migrated from .eslintrc.json (eslint:recommended only,
// which couldn't parse TypeScript) to eslint-config-next, which wires up the
// TypeScript parser plus the Next.js, react-hooks, and jsx-a11y rule sets.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Several files carry dormant `eslint-disable` directives for rules we keep
    // off (e.g. exhaustive-deps). Don't flag/strip them — they'd matter again if
    // those rules are re-enabled, and auto-removal leaves whitespace cruft.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'node_modules/**',
      'data/**', // runtime artifacts: logs, backups, generated JSON
      'public/**', // static assets
      'services/**', // vendored SearXNG source + Python signal-bridge — not our TS
      '**/*.min.js',
      'next-env.d.ts',
    ],
  },
  {
    rules: {
      // Preserved from the previous .eslintrc.json — intentionally off.
      'react-hooks/exhaustive-deps': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // tsc owns type-correctness; keep these visible but non-blocking.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      // react-hooks@7 React Compiler rules — informative, not build-breaking.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    // API routes are server-only — no React — so react-hooks misfires on plain
    // use*-named server helpers (e.g. useSkillDispatch).
    files: ['app/api/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    // skill-loader intentionally builds a CommonJS `module` shim to eval
    // transpiled custom-skill handlers.
    files: ['lib/skill-loader.ts'],
    rules: {
      '@next/next/no-assign-module-variable': 'off',
    },
  },
  {
    // Tests legitimately use require() (jest.mock, dynamic loading).
    files: ['**/__tests__/**', '**/tests/**', '**/*.test.{ts,tsx,js}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Imperative Three.js / react-three-fiber code: meshes, materials, and morph
    // influences must be mutated directly (including every frame in useFrame),
    // which the React Compiler immutability rule flags but is correct here.
    files: ['components/avatar/avatar-canvas.tsx'],
    rules: {
      'react-hooks/immutability': 'off',
    },
  },
];

export default config;

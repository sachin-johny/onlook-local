/**
 * Minimal Next.js + Tailwind template for local-mode projects.
 * Key is a relative path, value is file content.
 */
export const NEXTJS_TEMPLATE: Record<string, string> = {
    'package.json': JSON.stringify(
        {
            name: '{{PROJECT_NAME}}',
            version: '0.1.0',
            private: true,
            scripts: {
                dev: 'next dev --turbopack',
                build: 'next build',
                start: 'next start',
            },
            dependencies: {
                next: '^15.3.0',
                react: '^19.0.0',
                'react-dom': '^19.0.0',
            },
            devDependencies: {
                '@tailwindcss/postcss': '^4.0.0',
                tailwindcss: '^4.0.0',
                typescript: '^5.5.0',
                '@types/node': '^20.0.0',
                '@types/react': '^19.0.0',
                '@types/react-dom': '^19.0.0',
            },
        },
        null,
        2,
    ),

    'next.config.ts': [
        "import type { NextConfig } from 'next';",
        '',
        'const nextConfig: NextConfig = {};',
        '',
        'export default nextConfig;',
    ].join('\n'),

    'tsconfig.json': JSON.stringify(
        {
            compilerOptions: {
                target: 'ES2017',
                lib: ['dom', 'dom.iterable', 'esnext'],
                allowJs: true,
                skipLibCheck: true,
                strict: true,
                noEmit: true,
                esModuleInterop: true,
                module: 'esnext',
                moduleResolution: 'bundler',
                resolveJsonModule: true,
                isolatedModules: true,
                jsx: 'preserve',
                incremental: true,
                plugins: [{ name: 'next' }],
                paths: { '@/*': ['./src/*'] },
            },
            include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
            exclude: ['node_modules'],
        },
        null,
        2,
    ),

    'postcss.config.mjs': [
        '/** @type {import(\'postcss-load-config\').Config} */',
        'const config = {',
        '  plugins: {',
        "    '@tailwindcss/postcss': {},",
        '  },',
        '};',
        '',
        'export default config;',
    ].join('\n'),

    'src/app/globals.css': "@import 'tailwindcss';\n",

    'src/app/layout.tsx': [
        "import type { Metadata } from 'next';",
        "import './globals.css';",
        '',
        'export const metadata: Metadata = {',
        "    title: '{{PROJECT_NAME}}',",
        "    description: 'Created with Onlook',",
        '};',
        '',
        'export default function RootLayout({',
        '    children,',
        '}: {',
        '    children: React.ReactNode;',
        '}) {',
        '    return (',
        '        <html lang="en">',
        '            <body>{children}</body>',
        '        </html>',
        '    );',
        '}',
    ].join('\n'),

    'src/app/page.tsx': [
        'export default function Home() {',
        '    return (',
        '        <main className="flex min-h-screen items-center justify-center">',
        '            <div className="text-center">',
        '                <h1 className="text-4xl font-bold mb-4">Welcome to {{PROJECT_NAME}}</h1>',
        '                <p className="text-lg text-gray-600">',
        '                    Edit this page and save to see changes.',
        '                </p>',
        '            </div>',
        '        </main>',
        '    );',
        '}',
    ].join('\n'),

    '.env.example': '# Add your environment variables here\n',

    'README.md': [
        '# {{PROJECT_NAME}}',
        '',
        'Created with [Onlook](https://onlook.com).',
        '',
        '## Getting Started',
        '',
        '```bash',
        'bun dev',
        '```',
        '',
        'Open [http://localhost:3000](http://localhost:3000) in your browser.',
    ].join('\n'),
};

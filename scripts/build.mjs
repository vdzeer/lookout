// Bundles the extension and its uninstall hook (Node, CommonJS) into dist/.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  legalComments: 'none',
  logLevel: 'info',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js' },
  // Run by the editor once the extension is uninstalled: puts the status line back.
  { ...common, entryPoints: ['src/uninstall.ts'], outfile: 'dist/uninstall.js' },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Nicely report build problems in the terminal / VS Code problem matcher. */
const problemReporter = {
  name: 'problem-reporter',
  setup(build) {
    build.onStart(() => console.log('[build] started'));
    build.onEnd((result) => {
      for (const err of result.errors) {
        console.error(`✖ [ERROR] ${err.text}`);
        if (err.location) {
          console.error(`    ${err.location.file}:${err.location.line}:${err.location.column}`);
        }
      }
      console.log('[build] finished');
    });
  },
};

async function main() {
  /** The extension host bundle (Node / CommonJS). */
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    outfile: 'dist/extension.js',
    sourcemap: !production,
    minify: production,
    logLevel: 'silent',
    plugins: [problemReporter],
  });

  /** The webview bundle (browser / IIFE) — includes markdown-it. */
  const webviewCtx = await esbuild.context({
    entryPoints: ['src/webview/viewer.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: 'media/viewer.js',
    sourcemap: !production,
    minify: production,
    logLevel: 'silent',
    plugins: [problemReporter],
  });

  /**
   * Mermaid is large (~3 MB), so it lives in its own bundle that the webview
   * loads on demand — only when a note actually contains a diagram.
   */
  const mermaidCtx = await esbuild.context({
    entryPoints: ['src/webview/mermaid-entry.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: 'media/mermaid.js',
    sourcemap: false,
    minify: true,
    logLevel: 'silent',
    plugins: [problemReporter],
  });

  const contexts = [extensionCtx, webviewCtx, mermaidCtx];
  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[watch] watching for changes...');
  } else {
    for (const ctx of contexts) {
      await ctx.rebuild();
    }
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { build, context } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [join(root, 'src/content/index.ts')],
  bundle: true,
  outfile: join(dist, 'content.js'),
  platform: 'browser',
  format: 'iife',
  target: ['firefox115'],
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
};

async function copyStatic() {
  await copyFile(join(root, 'manifest.json'), join(dist, 'manifest.json'));
  await copyFile(join(root, 'src/content/styles.css'), join(dist, 'content.css'));
  await copyFile(join(root, 'assets/icon.svg'), join(dist, 'icon.svg'));
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{
      name: 'copy-static',
      setup(b) { b.onEnd(() => copyStatic()); },
    }],
  });
  await ctx.watch();
  console.log('watching...');
} else {
  await build(options);
  await copyStatic();
  console.log('built -> dist/');
}

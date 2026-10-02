import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, sourcemap: false, outfile: 'dist/app.js', target: ['es2022'], format: 'esm', external: ['/assets/*'] });
await copyFile('src/index.html', 'dist/index.html');
await cp('src/assets', 'dist/assets', { recursive: true });
await rm('dist/favicon.svg', { force: true });
console.log('Built the Readers Council app into dist.');

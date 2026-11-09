// Builds the static site into dist/. Usage: node build.mjs [--serve]
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';

const serve = process.argv.includes('--serve');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/decoders', { recursive: true });
cpSync('src/index.html', 'dist/index.html');
cpSync('src/style.css', 'dist/style.css');
cpSync('node_modules/three/examples/jsm/libs/draco/gltf', 'dist/decoders/draco', { recursive: true });
cpSync('node_modules/three/examples/jsm/libs/basis', 'dist/decoders/basis', { recursive: true });
for (const f of ['dist/decoders/draco/draco_encoder.js', 'dist/decoders/basis/README.md']) rmSync(f, { force: true });
// samples get a .txt suffix so any static host serves them; the page passes the real name
if (existsSync('samples')) {
  mkdirSync('dist/samples', { recursive: true });
  cpSync('samples/street-canyon.plt', 'dist/samples/street-canyon.plt.txt');
  cpSync('samples/scan-cloud.ply', 'dist/samples/scan-cloud.ply.txt');
}

const opts = {
  entryPoints: ['src/main.js'], bundle: true, format: 'esm', outfile: 'dist/app.js',
  minify: !serve, sourcemap: serve, target: 'es2022', logLevel: 'info',
};
if (serve) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: 'dist', port: 5173 });
  console.log(`GlbViewer running at http://localhost:${port}`);
} else {
  await esbuild.build(opts);
}

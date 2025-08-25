import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(exec);
const isProd = process.env.NODE_ENV === 'production';
const isWatch = !!process.env.ROLLUP_WATCH;

/** Runs `node copy-plugin.mjs` after each write (only in watch). */
function copyAfterBuildPlugin() {
  return {
    name: 'copy-after-build',
    async writeBundle() {
      try {
        const { stdout, stderr } = await run('node copy-plugin.mjs');
        if (stdout) console.log(stdout.trim());
        if (stderr) console.error(stderr.trim());
      } catch (e) {
        console.error(e.stderr?.trim() || e.message);
      }
    }
  };
}

export default {
  input: './src/main.ts',
  output: {
	file: 'main.js',
	format: 'cjs',
	sourcemap: true,
  },
  external: ['obsidian'],
  plugins: [
    typescript(),
    resolve(),
    commonjs(),
    isProd && terser({
      compress: true,
      mangle: true,
      format: { comments: false }
    }),
    // only run copy on dev watch rebuilds
    isWatch && copyAfterBuildPlugin(),
  ].filter(Boolean),
};

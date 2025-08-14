import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: './src/main.ts',
  output: {
    dir: '.',
    format: 'cjs',
    sourcemap: true
  },
  external: ['obsidian'],
  plugins: [
    typescript(),
    resolve(),
    commonjs()
  ]
};

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  outfile: 'lib/index.js',
  sourcemap: false,
});

const external = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'];
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client.jsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external,
  write: false,
  metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !external.includes(dependency.path)) throw new Error(`未声明的客户端依赖：${dependency.path}`);
  }
}
const source = `window.__ModuleLoader__.load({
  id: 'dsh-local-session-delete',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${result.outputFiles[0].text}
    return module.exports;
  }
});\n`;
await writeFile(new URL('../lib/client.js', import.meta.url), source);
console.log(`已构建对话管理插件（客户端 ${Buffer.byteLength(source)} 字节）`);

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve('src/gitService.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded.require = name => name === 'vscode' ? {} : require(name);
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const { buildDiffPayload } = loaded.exports;

const file = (name, size) => `diff --git a/${name} b/${name}\n+++ b/${name}\n${'+x\n'.repeat(size)}`;

test('returns everything when it fits', () => {
  const diff = file('a.ts', 3);
  assert.equal(buildDiffPayload(' a.ts | 3\n', diff, 10000), `=== CHANGED FILES ===\n a.ts | 3\n\n=== DIFF ===\n${diff}`);
});

test('a huge file cannot push out the other files', () => {
  const diff = file('big.ts', 5000) + file('small.ts', 3);
  const out = buildDiffPayload(' stat\n', diff, 1000);
  assert.ok(out.length <= 1000);
  assert.match(out, /diff --git a\/small\.ts/);
  assert.match(out, /diff --git a\/big\.ts/);
  assert.match(out, /diff truncated/);
});

test('keeps original file order and respects the limit with many files', () => {
  const diff = ['a', 'b', 'c', 'd'].map(n => file(`${n}.ts`, 200)).join('');
  const out = buildDiffPayload('stat', diff, 800);
  assert.ok(out.length <= 800);
  const positions = ['a', 'b', 'c', 'd'].map(n => out.indexOf(`a/${n}.ts`));
  assert.ok(positions.every(p => p >= 0));
  assert.deepEqual([...positions].sort((x, y) => x - y), positions);
});

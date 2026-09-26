const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function setup(behavior = {}, settings = {}) {
  const config = { provider: 'claude-code', ...settings };
  const spawned = [];
  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    let input = '';
    child.stdin.on('data', c => { input += c; });
    spawned.push({ command, args, options, input: () => input });
    options.signal?.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; child.emit('error', e);
    });
    process.nextTick(() => {
      if (behavior.hang) return;
      if (behavior.enoent) { const e = new Error('spawn'); e.code = 'ENOENT'; child.emit('error', e); return; }
      if (behavior.stdout) child.stdout.write(behavior.stdout);
      if (behavior.stderr) child.stderr.write(behavior.stderr);
      setImmediate(() => child.emit('close', behavior.code ?? 0));
    });
    return child;
  };
  const filename = path.resolve('src/openaiService.ts');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded.require = name => name === 'vscode'
    ? { workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) } }
    : name === 'child_process' ? { spawn: fakeSpawn } : require(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
  let secretReads = 0;
  return {
    service: new loaded.exports.OpenAIService({ get: async () => { secretReads++; return undefined; } }),
    CancelledError: loaded.exports.CancelledError,
    spawned, secretReads: () => secretReads,
  };
}

test('Claude Code sends the prompt over stdin and needs no API key', async () => {
  const s = setup({ stdout: '  feat(x): add thing\n' }, { 'claudeCode.model': 'sonnet', includeBody: false });
  assert.equal(await s.service.generateCommitMessage('+ code'), 'feat(x): add thing');
  assert.equal(s.secretReads(), 0);
  const call = s.spawned[0];
  assert.equal(call.command, 'claude');
  assert.ok(call.args.includes('-p'));
  assert.deepEqual(call.args.slice(call.args.indexOf('--tools'), call.args.indexOf('--tools') + 2), ['--tools', '']);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet');
  assert.match(call.input(), /single-line.*\n\n\+ code/s);
});

test('Claude Code strips API credentials so the subscription is used', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    const s = setup({ stdout: 'fix: y' });
    await s.service.generateCommitMessage('diff');
    assert.equal(s.spawned[0].options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(s.spawned[0].options.cwd, require('node:os').tmpdir());
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test('Claude Code honors a custom CLI path and empty model', async () => {
  const s = setup({ stdout: 'fix: y' }, { 'claudeCode.path': '/opt/claude', 'claudeCode.model': '' });
  await s.service.generateCommitMessage('diff');
  assert.equal(s.spawned[0].command, '/opt/claude');
  assert.ok(!s.spawned[0].args.includes('--model'));
});

test('Claude Code failures provide actionable errors', async () => {
  for (const [behavior, expected] of [
    [{ enoent: true }, /CLI not found/],
    [{ code: 1, stderr: 'Not logged in' }, /exit 1.*Not logged in.*logged in/s],
    [{ stdout: '   ' }, /empty response/],
  ]) {
    await assert.rejects(setup(behavior).service.generateCommitMessage('diff'), expected);
  }
});

test('Claude Code times out', async () => {
  await assert.rejects(setup({ hang: true }, { 'claudeCode.timeout': 0.01 }).service.generateCommitMessage('diff'), /timed out/);
});

test('cancellation aborts the request and surfaces CancelledError', async () => {
  const s = setup({ hang: true });
  let cancel;
  const token = { isCancellationRequested: false, onCancellationRequested: fn => { cancel = fn; return { dispose() {} }; } };
  const pending = s.service.generateCommitMessage('diff', token);
  await new Promise(r => setImmediate(r));
  token.isCancellationRequested = true;
  cancel();
  await assert.rejects(pending, s.CancelledError);
});

test('an already-cancelled token never spawns the CLI', async () => {
  const s = setup({ stdout: 'fix: y' });
  const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
  await assert.rejects(s.service.generateCommitMessage('diff', token), s.CancelledError);
  assert.equal(s.spawned.length, 0);
});

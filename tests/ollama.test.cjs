const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function setup(response = {}, settings = {}) {
  const config = { provider: 'ollama', ...settings };
  const calls = [];
  let secretReads = 0;
  const transport = {
    request(url, options, callback) {
      const req = new EventEmitter();
      req.destroy = error => { req.emit('error', error); req.emit('close'); };
      req.end = body => {
        calls.push({ url, options, body: JSON.parse(body) });
        if (response.hang) return;
        process.nextTick(() => {
          if (response.network) { req.destroy(new Error('ECONNREFUSED')); return; }
          const res = new EventEmitter();
          res.statusCode = response.status ?? 200;
          res.setEncoding = () => {};
          callback(res);
          res.emit('data', response.raw ?? JSON.stringify(response.json ?? { message: { content: ' feat: add local AI ' } }));
          res.emit('end');
          req.emit('close');
        });
      };
      return req;
    },
  };
  const filename = path.resolve('src/openaiService.ts');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded.require = name => name === 'vscode'
    ? { workspace: { getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) } }
    : ['http', 'https'].includes(name) ? transport : require(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
  return {
    service: new loaded.exports.OpenAIService({ get: async () => { secretReads++; return undefined; } }),
    calls, secretReads: () => secretReads,
  };
}

test('Ollama uses the local API with no key and preserves prompt options', async () => {
  const s = setup({}, { includeBody: false, temperature: 0.2, 'ollama.model': 'custom:7b' });
  assert.equal(await s.service.generateCommitMessage('+ added code'), 'feat: add local AI');
  assert.equal(s.secretReads(), 0);
  const call = s.calls[0];
  assert.equal(call.url.href, 'http://localhost:11434/api/chat');
  assert.equal(call.options.headers.Authorization, undefined);
  assert.equal(call.body.model, 'custom:7b');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.options.temperature, 0.2);
  assert.match(call.body.messages[1].content, /single-line.*\n\n\+ added code/s);
});

test('Ollama failures provide actionable errors', async () => {
  for (const [response, expected] of [
    [{ status: 404 }, /ollama pull/],
    [{ status: 503 }, /HTTP 503/],
    [{ raw: 'not json' }, /parse Ollama/],
    [{ json: { message: { content: '' } } }, /empty response/],
    [{ json: { error: 'model failed' } }, /model failed/],
    [{ network: true }, /ollama serve/],
  ]) {
    await assert.rejects(setup(response).service.generateCommitMessage('diff'), expected);
  }
});

test('Ollama validates endpoint and bounds request duration', async () => {
  await assert.rejects(setup({}, { 'ollama.baseUrl': 'file:///tmp/model' }).service.generateCommitMessage('diff'), /HTTP\(S\)/);
  await assert.rejects(setup({ hang: true }, { 'ollama.timeout': 0.01 }).service.generateCommitMessage('diff'), /timed out/);
});

test('OpenAI still requires its API key', async () => {
  const s = setup({}, { provider: 'openai' });
  await assert.rejects(s.service.generateCommitMessage('diff'), /API Key is not configured/);
  assert.equal(s.secretReads(), 1);
  assert.equal(s.calls.length, 0);
});

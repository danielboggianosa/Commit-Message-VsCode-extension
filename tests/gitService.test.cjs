const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const Module = require('node:module');

const warnings = [];
let repositories = [];
let picked;
let pickCount = 0;
const vscode = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => 4000 }) },
  extensions: { getExtension: () => ({ isActive: false, activate: async () => ({ getAPI: () => ({ repositories }) }) }) },
  window: {
    showWarningMessage: message => warnings.push(message),
    showQuickPick: async items => { pickCount++; return items.find(item => item.repo.repoRoot === picked); },
  },
};
const filename = path.resolve('src/gitService.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded.require = name => name === 'vscode' ? vscode : require(name);
loaded._compile(compiled, filename);
const { GitService } = loaded.exports;

test('nested repositories, SCM targeting, picker cancellation and exact application', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-ai-test-')));
  try {
    const createRepo = (name, staged) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      execFileSync('git', ['init', '--quiet', dir]);
      if (staged) {
        fs.writeFileSync(path.join(dir, 'change.txt'), name);
        execFileSync('git', ['add', '.'], { cwd: dir });
      }
      return { rootUri: { fsPath: dir }, inputBox: { value: '' } };
    };
    const first = createRepo('first', true);
    const second = createRepo('second', true);
    const empty = createRepo('empty', false);
    repositories = [first, second, empty];
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
    const service = new GitService();
    assert.equal((await service.findReposWithStagedChanges()).length, 2);
    assert.equal((await service.resolveActiveRepo(second)).repoRoot, second.rootUri.fsPath);
    assert.equal(pickCount, 0);
    assert.equal(await service.resolveActiveRepo(empty), null);
    assert.match(warnings.at(-1), /empty/);
    picked = second.rootUri.fsPath;
    assert.equal((await service.resolveActiveRepo()).repoRoot, picked);
    picked = undefined;
    const warningCount = warnings.length;
    assert.equal(await service.resolveActiveRepo(), null);
    assert.equal(warnings.length, warningCount);
    const diff = await service.getStagedDiff(second.rootUri.fsPath);
    assert.match(diff.diff, /\+second/);
    assert.doesNotMatch(diff.diff, /\+first/);
    assert.equal(await service.setCommitMessage('chosen', second.rootUri.fsPath), true);
    assert.equal(second.inputBox.value, 'chosen');
    assert.equal(first.inputBox.value, '');
    assert.equal(await service.setCommitMessage('wrong', path.join(first.rootUri.fsPath, 'child')), false);
    assert.equal(await service.setCommitMessage('wrong', root), false);
    const subfolder = path.join(first.rootUri.fsPath, 'subfolder');
    fs.mkdirSync(subfolder);
    vscode.workspace.workspaceFolders.push({ uri: { fsPath: subfolder } });
    assert.equal((await service.findReposWithStagedChanges()).length, 2);
    repositories = [];
    assert.equal((await service.findReposWithStagedChanges())[0].repoRoot, first.rootUri.fsPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

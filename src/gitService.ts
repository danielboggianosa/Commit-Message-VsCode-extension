import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// VSCode Git extension API types
interface GitExtensionAPI {
  getAPI(version: 1): GitAPI;
}
interface GitAPI {
  repositories: GitRepository[];
}
interface GitRepository {
  inputBox: { value: string };
  rootUri: vscode.Uri;
}

export interface StagedRepo {
  /** Absolute path to the git repository root */
  repoRoot: string;
  /** Display label shown in QuickPick (folder name) */
  label: string;
  /** Number of staged files */
  stagedFiles: number;
}

export interface StagedDiffResult {
  diff: string;
  repoRoot: string;
}

// Paths that rarely help describe a change and can swamp the diff budget.
const NOISE_PATHSPECS = [
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lockb',
  '**/Cargo.lock', '**/composer.lock', '**/poetry.lock', '**/Gemfile.lock', '**/go.sum',
  '**/*.min.js', '**/*.min.css', '**/*.map',
  'dist/**', 'build/**', 'out/**', '**/node_modules/**',
];

const TRUNCATION_NOTE = '[... diff truncated ...]';

/**
 * Builds the prompt payload within `maxLength`. The stat summary always comes first,
 * and the remaining budget is shared fairly between files (small files stay whole,
 * large ones are cut) so one big file cannot hide the rest of the change.
 */
export function buildDiffPayload(stat: string, diff: string, maxLength: number): string {
  const header = `=== CHANGED FILES ===\n${stat}\n=== DIFF ===\n`;
  if (header.length + diff.length <= maxLength) return header + diff;

  const files = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const budget = Math.max(maxLength - header.length, 0);
  const order = files.map((text, i) => ({ text, i })).sort((x, y) => x.text.length - y.text.length);
  const parts: string[] = new Array(files.length);
  let remaining = budget;
  order.forEach(({ text, i }, n) => {
    const share = Math.floor(remaining / (order.length - n));
    const note = `\n${TRUNCATION_NOTE}\n`;
    const piece = text.length <= share
      ? text
      : share > note.length ? text.substring(0, share - note.length) + note : '';
    parts[i] = piece;
    remaining -= piece.length;
  });
  return (header + parts.join('')).substring(0, Math.max(maxLength, header.length));
}

export class GitService {

  private async getRepositories(): Promise<GitRepository[]> {
    const extension = vscode.extensions.getExtension<GitExtensionAPI>('vscode.git');
    if (!extension) return [];
    const git = extension.isActive ? extension.exports : await extension.activate();
    return git.getAPI(1).repositories;
  }

  private async getStagedRepo(repoRoot: string): Promise<StagedRepo> {
    const { stdout } = await execAsync('git diff --cached --name-only -z', {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    return {
      repoRoot,
      label: path.basename(repoRoot),
      stagedFiles: stdout.split('\0').filter(Boolean).length,
    };
  }

  // Use Git's discovered repositories, including nested repos and submodules.
  async findReposWithStagedChanges(): Promise<StagedRepo[]> {
    const roots = new Set((await this.getRepositories()).map(r => r.rootUri.fsPath));

    // Also support workspace folders that Git has not discovered yet, resolving
    // subfolders to their actual repository root and avoiding duplicates.
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const { stdout } = await execAsync('git rev-parse --show-toplevel', {
          cwd: folder.uri.fsPath,
        });
        roots.add(stdout.trim());
      } catch {
        // A workspace folder may only be a container for repositories.
      }
    }

    const repos = await Promise.all([...roots].map(async root => {
      try {
        return await this.getStagedRepo(root);
      } catch {
        return null;
      }
    }));
    return repos.filter((repo): repo is StagedRepo => repo !== null && repo.stagedFiles > 0);
  }

  async resolveActiveRepo(context?: { rootUri?: vscode.Uri }): Promise<StagedRepo | null> {
    // SCM title actions pass the source control provider. Honor that target even
    // when another repository is the only one with staged changes.
    if (context?.rootUri) {
      const repo = await this.getStagedRepo(context.rootUri.fsPath);
      if (repo.stagedFiles > 0) return repo;
      vscode.window.showWarningMessage(
        `Commit AI: No staged changes found in "${repo.label}". Please run \`git add\` first.`
      );
      return null;
    }

    const repos = await this.findReposWithStagedChanges();
    if (repos.length === 0) {
      vscode.window.showWarningMessage(
        'Commit AI: No staged changes found in any repository. Please run `git add` first.'
      );
      return null;
    }
    if (repos.length === 1) return repos[0];

    const picked = await vscode.window.showQuickPick(repos.map(repo => ({
      label: `$(repo) ${repo.label}`,
      description: `${repo.stagedFiles} staged file${repo.stagedFiles !== 1 ? 's' : ''}`,
      detail: repo.repoRoot,
      repo,
    })), {
      title: 'Commit AI — Multiple repositories with staged changes',
      placeHolder: 'Select the repository to generate a commit message for',
      ignoreFocusOut: true,
    });
    return picked?.repo ?? null;
  }

  // ── Staged diff for a specific repo root ─────────────────────────────────

  async getStagedDiff(repoRoot: string): Promise<StagedDiffResult | null> {
    try {
      const excludes = NOISE_PATHSPECS.map(p => `':(exclude,glob)${p}'`).join(' ');
      const pathspec = `-- . ${excludes}`;

      // Lockfiles, build output and minified files add noise, so they are left out.
      // If every staged file is noise, fall back to the full diff.
      let { stdout: stat } = await execAsync(
        `git diff --cached --stat ${pathspec}`,
        { cwd: repoRoot, maxBuffer: 1024 * 512 }
      );
      let filter = pathspec;
      if (!stat.trim()) {
        filter = '';
        ({ stdout: stat } = await execAsync('git diff --cached --stat', { cwd: repoRoot, maxBuffer: 1024 * 512 }));
      }
      if (!stat.trim()) return null;

      const { stdout: diff } = await execAsync(
        `git diff --cached --unified=3 ${filter}`,
        { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 }
      );
      if (!diff.trim()) return null;

      const config = vscode.workspace.getConfiguration('commitAI');
      const maxLength = config.get<number>('maxDiffLength', 4000);

      return { diff: buildDiffPayload(stat, diff, maxLength), repoRoot };
    } catch (err) {
      const error = err as Error;
      if (error.message?.includes('not a git repository')) {
        throw new Error(`"${path.basename(repoRoot)}" is not a Git repository.`);
      }
      return null;
    }
  }

  // ── Write to SCM input box for a specific repo ────────────────────────────

  async setCommitMessage(message: string, repoRoot: string): Promise<boolean> {
    const repositories = await this.getRepositories();
    const repo = repositories.find(r => r.rootUri.fsPath === repoRoot);
    if (!repo) return false;

    repo.inputBox.value = message;
    return true;
  }
}

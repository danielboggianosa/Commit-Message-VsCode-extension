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
      const { stdout: stat } = await execAsync(
        'git diff --cached --stat',
        { cwd: repoRoot, maxBuffer: 1024 * 512 }
      );

      if (!stat.trim()) return null;

      const { stdout: diff } = await execAsync(
        'git diff --cached --unified=3',
        { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 }
      );

      if (!diff.trim()) return null;

      const config = vscode.workspace.getConfiguration('commitAI');
      const maxLength = config.get<number>('maxDiffLength', 4000);

      const combined = `=== CHANGED FILES ===\n${stat}\n=== DIFF ===\n${diff}`;
      return {
        diff: combined.length > maxLength
          ? combined.substring(0, maxLength) + '\n\n[... diff truncated for brevity ...]'
          : combined,
        repoRoot,
      };
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

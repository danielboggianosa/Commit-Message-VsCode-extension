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

  // ── Find all workspace folders that have staged changes ───────────────────

  async findReposWithStagedChanges(): Promise<StagedRepo[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];

    const results: StagedRepo[] = [];

    for (const folder of folders) {
      const fsPath = folder.uri.fsPath;
      try {
        const { stdout } = await execAsync(
          'git diff --cached --name-only',
          { cwd: fsPath, maxBuffer: 1024 * 64 }
        );
        const files = stdout.trim().split('\n').filter(Boolean);
        if (files.length > 0) {
          results.push({
            repoRoot: fsPath,
            label: path.basename(fsPath),
            stagedFiles: files.length,
          });
        }
      } catch {
        // Not a git repo or no git — skip silently
      }
    }

    return results;
  }

  // ── Resolve which repo to use (with QuickPick if multiple) ───────────────

  async resolveActiveRepo(): Promise<StagedRepo | null> {
    const repos = await this.findReposWithStagedChanges();

    if (repos.length === 0) return null;
    if (repos.length === 1) return repos[0];

    // Multiple repos with staged changes — ask the user
    const items = repos.map((r) => ({
      label: `$(repo) ${r.label}`,
      description: `${r.stagedFiles} staged file${r.stagedFiles !== 1 ? 's' : ''}`,
      detail: r.repoRoot,
      repo: r,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Commit AI — Multiple repositories with staged changes',
      placeHolder: 'Select the repository to generate a commit message for',
      ignoreFocusOut: true,
    });

    return picked ? picked.repo : null;
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
    const gitExt = vscode.extensions.getExtension<GitExtensionAPI>('vscode.git');
    if (!gitExt) return false;

    const git = gitExt.isActive ? gitExt.exports : await gitExt.activate();
    const api = git.getAPI(1);
    if (api.repositories.length === 0) return false;

    // Match by exact path, then by startsWith (submodule edge case), then fallback
    const repo =
      api.repositories.find((r) => r.rootUri.fsPath === repoRoot) ??
      api.repositories.find((r) => repoRoot.startsWith(r.rootUri.fsPath)) ??
      api.repositories[0];

    repo.inputBox.value = message;
    return true;
  }
}

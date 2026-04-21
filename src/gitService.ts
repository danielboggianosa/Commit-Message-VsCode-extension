import * as vscode from 'vscode';
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

export class GitService {
  // ── Workspace helpers ─────────────────────────────────────────────────────

  private getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;
  }

  // ── Staged diff ───────────────────────────────────────────────────────────

  async getStagedDiff(): Promise<string | null> {
    const root = this.getWorkspaceRoot();
    if (!root) return null;

    try {
      // Get stat summary first, then the actual diff
      const { stdout: stat } = await execAsync(
        'git diff --cached --stat',
        { cwd: root, maxBuffer: 1024 * 512 }
      );

      if (!stat.trim()) return null;

      const { stdout: diff } = await execAsync(
        'git diff --cached --unified=3',
        { cwd: root, maxBuffer: 1024 * 1024 * 10 } // 10MB
      );

      if (!diff.trim()) return null;

      const config = vscode.workspace.getConfiguration('commitAI');
      const maxLength = config.get<number>('maxDiffLength', 4000);

      const combined = `=== CHANGED FILES ===\n${stat}\n=== DIFF ===\n${diff}`;
      return combined.length > maxLength
        ? combined.substring(0, maxLength) + '\n\n[... diff truncated for brevity ...]'
        : combined;
    } catch (err) {
      const error = err as NodeJS.ErrnoException & { stderr?: string };
      // Not a git repo or no git installed
      if (error.message?.includes('not a git repository')) {
        throw new Error('This workspace is not a Git repository.');
      }
      return null;
    }
  }

  // ── Check for staged changes (fast check) ────────────────────────────────

  async hasStagedChanges(): Promise<boolean> {
    const root = this.getWorkspaceRoot();
    if (!root) return false;

    try {
      const { stdout } = await execAsync(
        'git diff --cached --name-only',
        { cwd: root, maxBuffer: 1024 * 64 }
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  // ── Write to SCM input box via VSCode Git API ─────────────────────────────

  async setCommitMessage(message: string): Promise<boolean> {
    const gitExt = vscode.extensions.getExtension<GitExtensionAPI>('vscode.git');
    if (!gitExt) return false;

    const git = gitExt.isActive
      ? gitExt.exports
      : await gitExt.activate();

    const api = git.getAPI(1);
    if (api.repositories.length === 0) return false;

    // Try to match the repository that corresponds to the workspace
    const root = this.getWorkspaceRoot();
    const repo = root
      ? api.repositories.find((r) => r.rootUri.fsPath === root) ?? api.repositories[0]
      : api.repositories[0];

    repo.inputBox.value = message;
    return true;
  }
}

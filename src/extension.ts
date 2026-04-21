import * as vscode from 'vscode';

import { GitService } from './gitService';
import { OpenAIService } from './openaiService';
import { CommitPreviewPanel } from './commitPreviewPanel';
import { HistoryProvider, HistoryItem } from './historyProvider';

// ─── Activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gitService = new GitService();
  const openaiService = new OpenAIService(context.secrets);
  const historyProvider = new HistoryProvider(context.globalState);

  // ── History tree view ────────────────────────────────────────────────────

  const historyView = vscode.window.createTreeView('commitAI.history', {
    treeDataProvider: historyProvider,
    showCollapseAll: false,
  });

  // Show empty-state message
  historyView.message = historyProvider.getCount() === 0
    ? 'No messages yet. Use the ✨ button in Source Control to generate one.'
    : undefined;

  // ── Helper: ensure API key is set ────────────────────────────────────────

  async function ensureApiKey(): Promise<boolean> {
    const key = await openaiService.getApiKey();
    if (key) return true;

    const action = await vscode.window.showWarningMessage(
      'Commit AI: OpenAI API Key is not configured.',
      { modal: false },
      'Set API Key'
    );

    if (action === 'Set API Key') {
      await vscode.commands.executeCommand('commitAI.setApiKey');
      // Re-check after user input
      return !!(await openaiService.getApiKey());
    }
    return false;
  }

  // ── Command: Generate message ────────────────────────────────────────────

  const generateCmd = vscode.commands.registerCommand(
    'commitAI.generateMessage',
    async () => {
      // 1. Verify API key
      if (!(await ensureApiKey())) return;

      // 2. Find which repo(s) have staged changes — handles multi-root workspaces
      const activeRepo = await gitService.resolveActiveRepo();
      if (!activeRepo) {
        vscode.window.showWarningMessage(
          'Commit AI: No staged changes found in any repository. Please run `git add` first.'
        );
        return;
      }

      // 3. Run with progress notification
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Commit AI',
          cancellable: false,
        },
        async (progress) => {
          try {
            progress.report({ message: `Reading diff from "${activeRepo.label}"…` });
            const result = await gitService.getStagedDiff(activeRepo.repoRoot);

            if (!result) {
              vscode.window.showWarningMessage(
                'Commit AI: Could not read the staged diff.'
              );
              return;
            }

            progress.report({ increment: 30, message: 'Asking OpenAI…' });
            const generatedMessage = await openaiService.generateCommitMessage(result.diff);

            progress.report({ increment: 60, message: 'Done!' });

            // 4. Show editable preview
            CommitPreviewPanel.show(
              generatedMessage,
              async (finalMessage) => {
                // Apply to the correct repo's SCM input box
                const applied = await gitService.setCommitMessage(finalMessage, result.repoRoot);
                if (applied) {
                  historyProvider.addEntry(finalMessage);
                  historyView.message = undefined;
                  vscode.window.showInformationMessage(
                    `Commit AI: Message applied to "${activeRepo.label}" ✓`
                  );
                } else {
                  await vscode.env.clipboard.writeText(finalMessage);
                  vscode.window.showInformationMessage(
                    'Commit AI: Message copied to clipboard (could not find repository).'
                  );
                }
              },
              () => {
                vscode.commands.executeCommand('commitAI.generateMessage');
              }
            );
          } catch (err) {
            const error = err as Error;
            vscode.window.showErrorMessage(`Commit AI: ${error.message}`);
          }
        }
      );
    }
  );

  // ── Command: Set API Key ─────────────────────────────────────────────────

  const setApiKeyCmd = vscode.commands.registerCommand(
    'commitAI.setApiKey',
    async () => {
      const existing = await openaiService.getApiKey();

      const input = await vscode.window.showInputBox({
        title: 'Commit AI — OpenAI API Key',
        prompt: existing
          ? 'Enter a new key to replace the current one, or press Escape to keep it.'
          : 'Paste your OpenAI API key. It will be stored securely in VS Code.',
        password: true,
        placeHolder: 'sk-...',
        ignoreFocusOut: true,
        validateInput: (v) => {
          if (!v) return null; // allow empty to cancel
          if (!v.startsWith('sk-') || v.length < 20) {
            return 'Invalid key format — it should start with "sk-"';
          }
          return null;
        },
      });

      if (!input) return; // Escaped

      await openaiService.setApiKey(input);
      vscode.window.showInformationMessage(
        'Commit AI: API Key saved securely ✓'
      );
    }
  );

  // ── Command: Clear history ───────────────────────────────────────────────

  const clearHistoryCmd = vscode.commands.registerCommand(
    'commitAI.clearHistory',
    async () => {
      const count = historyProvider.getCount();
      if (count === 0) {
        vscode.window.showInformationMessage('Commit AI: History is already empty.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Clear all ${count} history entries?`,
        { modal: true },
        'Clear'
      );

      if (confirm === 'Clear') {
        historyProvider.clearHistory();
        historyView.message =
          'No messages yet. Use the ✨ button in Source Control to generate one.';
        vscode.window.showInformationMessage('Commit AI: History cleared.');
      }
    }
  );

  // ── Command: Copy history item ───────────────────────────────────────────

  const copyItemCmd = vscode.commands.registerCommand(
    'commitAI.copyHistoryItem',
    async (item: HistoryItem) => {
      await vscode.env.clipboard.writeText(item.fullMessage);
      vscode.window.showInformationMessage('Commit AI: Message copied to clipboard.');
    }
  );

  // ── Command: Apply history item to SCM box ───────────────────────────────

  const applyItemCmd = vscode.commands.registerCommand(
    'commitAI.applyHistoryItem',
    async (item: HistoryItem) => {
      // Resolve the target repo (multi-root aware)
      const activeRepo = await gitService.resolveActiveRepo();
      const repoRoot = activeRepo?.repoRoot;

      if (!repoRoot) {
        // No staged changes anywhere — just pick the first available repo
        const allRepos = vscode.workspace.workspaceFolders;
        const fallbackRoot = allRepos?.[0]?.uri.fsPath;
        if (fallbackRoot) {
          await gitService.setCommitMessage(item.fullMessage, fallbackRoot);
          vscode.window.showInformationMessage('Commit AI: Message applied to Source Control ✓');
        } else {
          await vscode.env.clipboard.writeText(item.fullMessage);
          vscode.window.showInformationMessage('Commit AI: Copied to clipboard (no Git repository found).');
        }
        return;
      }

      const applied = await gitService.setCommitMessage(item.fullMessage, repoRoot);
      if (applied) {
        vscode.window.showInformationMessage(
          `Commit AI: Message applied to "${activeRepo!.label}" ✓`
        );
      } else {
        await vscode.env.clipboard.writeText(item.fullMessage);
        vscode.window.showInformationMessage('Commit AI: Copied to clipboard (no active Git repository found).');
      }
    }
  );

  // ── Register all subscriptions ───────────────────────────────────────────

  context.subscriptions.push(
    historyView,
    generateCmd,
    setApiKeyCmd,
    clearHistoryCmd,
    copyItemCmd,
    applyItemCmd
  );
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  // Nothing to clean up — VSCode disposes subscriptions automatically
}

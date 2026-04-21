import * as vscode from 'vscode';

const HISTORY_KEY = 'commitAI.messageHistory';
const MAX_HISTORY = 50;

interface HistoryEntry {
  message: string;
  timestamp: number;
}

// ─── Tree Item ────────────────────────────────────────────────────────────────

export class HistoryItem extends vscode.TreeItem {
  constructor(
    public readonly fullMessage: string,
    public readonly timestamp: number
  ) {
    // First line is the commit subject
    const firstLine = fullMessage.split('\n')[0].trim();
    super(firstLine, vscode.TreeItemCollapsibleState.None);

    this.tooltip = new vscode.MarkdownString(
      `**${firstLine}**\n\n\`\`\`\n${fullMessage}\n\`\`\``
    );

    this.description = new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    this.contextValue = 'historyItem';
    this.iconPath = new vscode.ThemeIcon('git-commit');

    // Single-click → apply directly
    this.command = {
      command: 'commitAI.applyHistoryItem',
      title: 'Apply to Commit',
      arguments: [this],
    };
  }
}

// ─── Tree Data Provider ───────────────────────────────────────────────────────

export class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<HistoryItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly globalState: vscode.Memento) {}

  // ── vscode.TreeDataProvider implementation ──────────────────────────────

  getTreeItem(element: HistoryItem): vscode.TreeItem {
    return element;
  }

  getChildren(): HistoryItem[] {
    const history = this.loadHistory();
    if (history.length === 0) return [];
    return history.map((e) => new HistoryItem(e.message, e.timestamp));
  }

  // ── Public API ──────────────────────────────────────────────────────────

  addEntry(message: string): void {
    const history = this.loadHistory();

    // Avoid duplicate consecutive entries
    if (history.length > 0 && history[0].message === message) return;

    history.unshift({ message, timestamp: Date.now() });

    // Cap the list
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

    this.globalState.update(HISTORY_KEY, history);
    this._onDidChangeTreeData.fire();
  }

  clearHistory(): void {
    this.globalState.update(HISTORY_KEY, []);
    this._onDidChangeTreeData.fire();
  }

  getCount(): number {
    return this.loadHistory().length;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private loadHistory(): HistoryEntry[] {
    return this.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  }
}

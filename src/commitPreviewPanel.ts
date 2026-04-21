import * as vscode from 'vscode';

type ApplyCallback = (message: string) => Promise<void>;
type RegenerateCallback = () => void;

// ─── Panel ────────────────────────────────────────────────────────────────────

export class CommitPreviewPanel {
  private static instance: CommitPreviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private message: string,
    private readonly onApply: ApplyCallback,
    private readonly onRegenerate: RegenerateCallback
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'commitAIPreview',
      '✨ Commit Message Preview',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.buildHtml(message);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      async (msg: { command: string; message?: string }) => {
        switch (msg.command) {
          case 'apply':
            if (msg.message) {
              await this.onApply(msg.message);
            }
            this.panel.dispose();
            break;

          case 'regenerate':
            this.panel.dispose();
            this.onRegenerate();
            break;

          case 'cancel':
            this.panel.dispose();
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      CommitPreviewPanel.instance = undefined;
      this.dispose();
    }, null, this.disposables);
  }

  // ── Public factory ────────────────────────────────────────────────────────

  static show(
    message: string,
    onApply: ApplyCallback,
    onRegenerate: RegenerateCallback
  ): void {
    // Close previous panel if open
    CommitPreviewPanel.instance?.panel.dispose();
    CommitPreviewPanel.instance = new CommitPreviewPanel(message, onApply, onRegenerate);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  private dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(message: string): string {
    // Safely encode the message for embedding in HTML/JS
    const safeMessage = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const jsMessage = JSON.stringify(message); // safe for JS string

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Commit Message Preview</title>
<style>
/* ── Reset & base ─────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  padding: 24px 20px;
  min-height: 100vh;
}

/* ── Header ───────────────────────────────────────────────── */
.header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 22px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
}
.header-emoji { font-size: 24px; line-height: 1; margin-top: 1px; }
.header-text h1 {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -.01em;
  margin-bottom: 3px;
}
.header-text p {
  font-size: 12px;
  opacity: .6;
}
.badge {
  margin-left: auto;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .03em;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Label ────────────────────────────────────────────────── */
.field-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .07em;
  opacity: .5;
  margin-bottom: 8px;
}

/* ── Textarea ─────────────────────────────────────────────── */
.textarea-wrap { position: relative; }
textarea {
  display: block;
  width: 100%;
  min-height: 140px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
  border-radius: 4px;
  padding: 12px 14px;
  font-family: var(--vscode-editor-font-family, 'Menlo', 'Consolas', monospace);
  font-size: 13px;
  line-height: 1.65;
  resize: vertical;
  outline: none;
  transition: border-color .15s;
}
textarea:focus {
  border-color: var(--vscode-focusBorder, #007acc);
}
.char-counter {
  font-size: 11px;
  text-align: right;
  margin-top: 5px;
  opacity: .5;
  transition: color .15s, opacity .15s;
}
.char-counter.warn { color: #e8c261; opacity: 1; }
.char-counter.error { color: #f48771; opacity: 1; }

/* ── Karma cheatsheet ─────────────────────────────────────── */
.karma-box {
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25));
  border-radius: 4px;
  padding: 12px 14px;
  margin-top: 16px;
  font-size: 12px;
}
.karma-box .karma-title {
  font-weight: 600;
  opacity: .75;
  margin-bottom: 8px;
}
.karma-format {
  font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(128,128,128,.12);
  border-radius: 3px;
  padding: 5px 8px;
  opacity: .8;
  margin-bottom: 10px;
  font-size: 12px;
}
.types {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.type-chip {
  background: rgba(128,128,128,.15);
  border-radius: 3px;
  padding: 2px 7px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  opacity: .8;
}

/* ── Keyboard hint ────────────────────────────────────────── */
.kb-hint {
  font-size: 11px;
  opacity: .45;
  margin-top: 12px;
  text-align: center;
}
.kb-hint kbd {
  background: rgba(128,128,128,.2);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: inherit;
}

/* ── Action buttons ───────────────────────────────────────── */
.actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
  flex-wrap: wrap;
}
button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 15px;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: opacity .15s, background .15s;
  white-space: nowrap;
}
button:hover { opacity: .85; }
button:active { transform: translateY(1px); }

.btn-apply {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-weight: 600;
  flex: 1;
  justify-content: center;
}
.btn-apply:hover { background: var(--vscode-button-hoverBackground); opacity: 1; }

.btn-secondary {
  background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
  color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
}
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-emoji">✨</div>
  <div class="header-text">
    <h1>AI-Generated Commit Message</h1>
    <p>Review, edit if needed, then apply</p>
  </div>
  <span class="badge">Karma</span>
</div>

<!-- Message editor -->
<div class="field-label">Commit Message</div>
<div class="textarea-wrap">
  <textarea id="msg" spellcheck="true" autocorrect="off">${safeMessage}</textarea>
</div>
<div class="char-counter" id="counter">First line: <span id="len">0</span> / 72 chars</div>

<!-- Karma reference -->
<div class="karma-box">
  <div class="karma-title">📋 Karma Convention</div>
  <div class="karma-format">&lt;type&gt;(&lt;scope&gt;): &lt;subject&gt;</div>
  <div class="types">
    <span class="type-chip">feat</span>
    <span class="type-chip">fix</span>
    <span class="type-chip">docs</span>
    <span class="type-chip">style</span>
    <span class="type-chip">refactor</span>
    <span class="type-chip">perf</span>
    <span class="type-chip">test</span>
    <span class="type-chip">chore</span>
    <span class="type-chip">revert</span>
    <span class="type-chip">build</span>
    <span class="type-chip">ci</span>
  </div>
</div>

<div class="kb-hint"><kbd>Ctrl+Enter</kbd> to apply &nbsp;·&nbsp; <kbd>Esc</kbd> to cancel</div>

<!-- Action buttons -->
<div class="actions">
  <button class="btn-apply" id="btnApply" onclick="applyMsg()">✓ Apply to Commit</button>
  <button class="btn-secondary" onclick="regenerateMsg()">↺ Regenerate</button>
  <button class="btn-secondary" onclick="cancelPanel()">✕ Cancel</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const textarea = document.getElementById('msg');
  const lenEl = document.getElementById('len');
  const counter = document.getElementById('counter');

  // Initialise with the pre-filled message
  textarea.value = ${jsMessage};

  function updateCounter() {
    const firstLine = textarea.value.split('\\n')[0];
    const n = firstLine.length;
    lenEl.textContent = n;
    counter.className = n > 72 ? 'char-counter error'
      : n > 60 ? 'char-counter warn'
      : 'char-counter';
  }

  textarea.addEventListener('input', updateCounter);
  updateCounter();

  // Focus textarea at end
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  function applyMsg() {
    const msg = textarea.value.trim();
    if (!msg) return;
    vscode.postMessage({ command: 'apply', message: msg });
  }

  function regenerateMsg() {
    vscode.postMessage({ command: 'regenerate' });
  }

  function cancelPanel() {
    vscode.postMessage({ command: 'cancel' });
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      applyMsg();
    }
    if (e.key === 'Escape') {
      cancelPanel();
    }
  });
</script>
</body>
</html>`;
  }
}

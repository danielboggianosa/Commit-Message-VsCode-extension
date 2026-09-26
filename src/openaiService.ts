import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { spawn } from 'child_process';

// ─── Karma/Conventional Commits specification ────────────────────────────────
const KARMA_TYPES = [
  'feat',     // A new feature
  'fix',      // A bug fix
  'docs',     // Documentation only changes
  'style',    // Formatting, missing semicolons — no code change
  'refactor', // Neither a bug fix nor a feature
  'perf',     // Performance improvements
  'test',     // Adding or fixing tests
  'chore',    // Build process or auxiliary tool changes
  'revert',   // Reverts a previous commit
  'build',    // Changes that affect the build system
  'ci',       // CI/CD configuration changes
];

const SYSTEM_PROMPT = `You are an expert at writing Git commit messages following the Karma/Conventional Commits specification.

## Rules
1. **Format**: \`<type>(<scope>): <subject>\`
2. **Type** must be one of: ${KARMA_TYPES.join(', ')}
3. **Scope** is optional but recommended — use the module, component, or file name (e.g., auth, api, button, user-service)
4. **Subject**: imperative mood ("add" not "adds"/"added"), lowercase, no trailing period, max 72 chars
5. **Body** (optional): blank line after subject, explain WHAT changed and WHY — not how. Wrap at 72 chars.
6. **Footer** (optional): reference issues — e.g., \`Closes #123\`, \`Refs #456\`, \`BREAKING CHANGE: description\`

## When to add a body
- The diff includes non-obvious logic changes
- A bug fix that needs context about why it was wrong
- Multiple unrelated changes in one commit

## Good examples
\`\`\`
feat(auth): add JWT refresh token rotation

Refresh tokens now rotate on each use to prevent token theft.
Old tokens are invalidated immediately after refresh.

Closes #482
\`\`\`

\`\`\`
fix(api): handle null response from payment gateway
\`\`\`

\`\`\`
refactor(user): extract validation logic into UserValidatorService

Validation was duplicated across 3 controllers. Centralizing it
reduces the risk of inconsistent validation rules.
\`\`\`

\`\`\`
chore(deps): update dependencies to latest versions
\`\`\`

## Response format
Respond ONLY with the commit message — no markdown fences, no explanations, no extra text.
`;

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message: string;
    type: string;
    code?: string;
  };
}

export class CancelledError extends Error {
  constructor() { super('Generation cancelled.'); this.name = 'CancelledError'; }
}

export class OpenAIService {
  private readonly API_KEY_SECRET = 'commitAI.openaiApiKey';

  constructor(private readonly secrets: vscode.SecretStorage) {}

  // ── API Key management ────────────────────────────────────────────────────

  async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(this.API_KEY_SECRET);
  }

  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(this.API_KEY_SECRET, key);
  }

  async deleteApiKey(): Promise<void> {
    await this.secrets.delete(this.API_KEY_SECRET);
  }

  // ── Message generation ────────────────────────────────────────────────────

  async generateCommitMessage(diff: string, token?: vscode.CancellationToken): Promise<string> {
    const controller = new AbortController();
    const sub = token?.onCancellationRequested(() => controller.abort());
    try {
      if (token?.isCancellationRequested) throw new CancelledError();
      return await this.generate(diff, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw new CancelledError();
      throw err;
    } finally {
      sub?.dispose();
    }
  }

  private async generate(diff: string, signal: AbortSignal): Promise<string> {
    const config = vscode.workspace.getConfiguration('commitAI');
    const model = config.get<string>('model', 'gpt-4o-mini');
    const temperature = config.get<number>('temperature', 0.3);
    const includeBody = config.get<boolean>('includeBody', true);

    const userPrompt = includeBody
      ? `Generate a Karma-style commit message (with body if the changes are complex) for the following git diff:\n\n${diff}`
      : `Generate a single-line Karma-style commit message (no body) for the following git diff:\n\n${diff}`;

    const provider = config.get<string>('provider', 'openai');
    if (provider === 'ollama') {
      return this.callOllama(config, userPrompt, temperature, signal);
    }
    if (provider === 'claude-code') {
      return this.callClaudeCode(config, userPrompt, signal);
    }

    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('OpenAI API Key is not configured.');

    const requestBody = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 500,
      temperature,
    });

    return this.callOpenAI(apiKey, requestBody, signal);
  }

  // Uses the local Claude Code CLI, so requests are billed to the user's Claude subscription.
  private callClaudeCode(config: vscode.WorkspaceConfiguration, userPrompt: string, signal: AbortSignal): Promise<string> {
    const command = config.get<string>('claudeCode.path', 'claude').trim() || 'claude';
    const model = config.get<string>('claudeCode.model', 'haiku').trim();
    const timeout = config.get<number>('claudeCode.timeout', 120) * 1000;
    const args = ['-p', '--tools', '', '--no-session-persistence', '--system-prompt', SYSTEM_PROMPT];
    if (model) args.push('--model', model);

    // An API key in the environment would make the CLI bill the API instead of the subscription.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    return new Promise((resolve, reject) => {
      // Run from a temp dir so project CLAUDE.md files don't leak into the prompt.
      const child = spawn(command, args, { cwd: os.tmpdir(), env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let done = false;
      const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error('Claude Code timed out. Increase commitAI.claudeCode.timeout.')));
      }, timeout);
      child.stdout.setEncoding('utf8').on('data', c => { out += c; });
      child.stderr.setEncoding('utf8').on('data', c => { err += c; });
      child.stdin.on('error', () => { /* surfaced through close/error */ });
      child.on('error', e => finish(() => reject(new Error(
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Claude Code CLI not found ("${command}"). Install it and set commitAI.claudeCode.path if needed.`
          : `Claude Code: ${e.message}`))));
      child.on('close', code => finish(() => {
        const message = out.trim();
        if (code !== 0 || !message) {
          const detail = (err.trim() || message).slice(0, 300);
          reject(new Error(`Claude Code failed${code ? ` (exit ${code})` : ''}: ${detail || 'empty response'}. Make sure you are logged in (run "claude" once).`));
          return;
        }
        resolve(message);
      }));
      child.stdin.end(userPrompt);
    });
  }

  private callOllama(config: vscode.WorkspaceConfiguration, userPrompt: string, temperature: number, signal: AbortSignal): Promise<string> {
    const model = config.get<string>('ollama.model', 'qwen2.5-coder:3b').trim();
    if (!model) throw new Error('Set commitAI.ollama.model to a downloaded Ollama model.');
    let url: URL;
    try {
      url = new URL(config.get<string>('ollama.baseUrl', 'http://localhost:11434'));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      url.pathname = url.pathname.replace(/\/$/, '') + '/api/chat';
    } catch {
      throw new Error('commitAI.ollama.baseUrl must be an HTTP(S) server URL without credentials, query or fragment.');
    }
    const body = JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }],
      stream: false,
      options: { temperature, num_predict: 500 },
    });
    const timeout = config.get<number>('ollama.timeout', 120) * 1000;
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Ollama response was interrupted.')));
        res.on('end', () => {
          try {
            if (res.statusCode === 404) {
              reject(new Error(`Ollama model or endpoint not found. Download the model with: ollama pull ${model}. Check commitAI.ollama.baseUrl.`));
              return;
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`Ollama request failed (HTTP ${res.statusCode}). Check the Ollama server and selected model.`));
              return;
            }
            const parsed = JSON.parse(data);
            if (parsed.error) { reject(new Error(`Ollama: ${parsed.error}`)); return; }
            const message = parsed.message?.content;
            if (typeof message !== 'string' || !message.trim()) {
              reject(new Error('Ollama returned an empty response. Try another model.'));
              return;
            }
            resolve(message.trim());
          } catch { reject(new Error('Failed to parse Ollama response. Check commitAI.ollama.baseUrl.')); }
        });
      });
      const timer = setTimeout(() => {
        req.destroy(new Error('Ollama request timed out. Increase commitAI.ollama.timeout or use a smaller model.'));
      }, timeout);
      req.on('close', () => clearTimeout(timer));
      req.on('error', (err: Error) => reject(new Error(`Ollama: ${err.message}. Ensure Ollama is running (ollama serve).`)));
      req.end(body);
    });
  }

  // ── Internal HTTP request ─────────────────────────────────────────────────

  private callOpenAI(apiKey: string, body: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            const parsed: OpenAIResponse = JSON.parse(data);

            if (parsed.error) {
              const code = parsed.error.code ? ` (${parsed.error.code})` : '';
              reject(new Error(`OpenAI Error${code}: ${parsed.error.message}`));
              return;
            }

            const message = parsed.choices?.[0]?.message?.content?.trim();
            if (!message) {
              reject(new Error('OpenAI returned an empty response.'));
              return;
            }

            resolve(message);
          } catch {
            reject(new Error('Failed to parse OpenAI response.'));
          }
        });
      });

      req.on('error', (err: Error) => {
        reject(new Error(`Network error: ${err.message}`));
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('OpenAI request timed out after 30 seconds.'));
      });

      req.write(body);
      req.end();
    });
  }
}

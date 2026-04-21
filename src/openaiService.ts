import * as vscode from 'vscode';
import * as https from 'https';

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

  async generateCommitMessage(diff: string): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('OpenAI API Key is not configured.');
    }

    const config = vscode.workspace.getConfiguration('commitAI');
    const model = config.get<string>('model', 'gpt-4o-mini');
    const temperature = config.get<number>('temperature', 0.3);
    const includeBody = config.get<boolean>('includeBody', true);

    const userPrompt = includeBody
      ? `Generate a Karma-style commit message (with body if the changes are complex) for the following git diff:\n\n${diff}`
      : `Generate a single-line Karma-style commit message (no body) for the following git diff:\n\n${diff}`;

    const requestBody = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 500,
      temperature,
    });

    return this.callOpenAI(apiKey, requestBody);
  }

  // ── Internal HTTP request ─────────────────────────────────────────────────

  private callOpenAI(apiKey: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
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

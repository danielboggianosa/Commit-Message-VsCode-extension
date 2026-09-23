# KarmaMessageAI

Generate perfect Git commit messages using OpenAI or local models through Ollama, following the **Karma / Conventional Commits** specification.

\![Version](https://img.shields.io/badge/version-1.0.3-blue)
\![VSCode](https://img.shields.io/badge/VSCode-^1.85.0-007ACC)
\![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- **✨ One-click generation** — button in the Source Control panel header
- **Editable preview** — review and modify the message before applying (`Ctrl+Enter` to confirm)
- **Karma convention** — enforces `feat`, `fix`, `docs`, `refactor`, and all standard types
- **Message history** — side panel with the last 50 generated messages (click to re-apply)
- **Secure API key storage** — stored in VS Code's encrypted `SecretStorage` (OS Keychain)
- **Configurable model** — choose between `gpt-4o-mini`, `gpt-4o`, `gpt-4-turbo`, and `gpt-3.5-turbo`

---

## Karma Convention

Messages follow this format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

| Type | Description |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only changes |
| `style` | Formatting, no code change |
| `refactor` | Neither a fix nor a feature |
| `perf` | Performance improvements |
| `test` | Adding or fixing tests |
| `chore` | Build process or tooling changes |
| `revert` | Reverts a previous commit |
| `build` | Changes to the build system |
| `ci` | CI/CD configuration changes |

**Examples:**
```
feat(auth): add JWT refresh token rotation

Refresh tokens now rotate on each use to prevent token theft.

Closes #482
```
```
fix(api): handle null response from payment gateway
```
```
chore(deps): update dependencies to latest versions
```

---

## Requirements

- **VS Code** `^1.85.0`
- **Git** installed and available in your PATH
- Either an **OpenAI API Key** or **Ollama** with a downloaded local model.

---

## Installation

### Option A — Install from VSIX (recommended)

1. Build the package:
   ```bash
   npm install
   node esbuild.js --production
   npx vsce package --no-dependencies
   ```
2. In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
3. Select the generated `karma-message-ai-1.0.3.vsix` file
4. Reload VS Code

### Option B — Development mode (for testing)

1. Open the `Commit Message VsCode` folder in VS Code
2. Open `src/extension.ts`
3. Press **F5** — a new Extension Development Host window will open
4. In that window, open any Git repository and start using the extension

---

## Setup

### 1. Choose a provider

OpenAI remains the default. For a local option without an API key or per-request API fees:

1. Install and start [Ollama](https://ollama.com/download).
2. Download the default model: `ollama pull qwen2.5-coder:3b` (about 1.9 GB).
3. Add to VS Code settings:

   ```json
   "commitAI.provider": "ollama",
   "commitAI.ollama.model": "qwen2.5-coder:3b"
   ```

Keep Ollama running; use `ollama serve` if the service is not already active.
After downloading the model, local generation works offline. Speed and quality depend
on your hardware and selected model. Change `commitAI.ollama.model` to another model
you have downloaded. Local models use your computer's RAM and processing resources.

The default server is `http://localhost:11434`. Configure `commitAI.ollama.baseUrl`
if needed and `commitAI.ollama.timeout` (default 120 seconds) for slow model loading.
With Remote SSH, WSL or containers, localhost refers to the machine running the
extension host. The server must be reachable from there.

See [Ollama authentication](https://docs.ollama.com/api/authentication): local API
requests need no key; cloud models are a separate service and may require sign-in.

#### OpenAI setup

Set `commitAI.provider` to `openai` and configure your API key:


Open the Command Palette (`Ctrl+Shift+P`) and run:

```
Commit AI: Set OpenAI API Key
```

Paste your key (`sk-...`). It is stored securely using VS Code's built-in `SecretStorage` — it never touches disk in plain text.

### 2. Stage your changes

```bash
git add .
# or stage specific files in the Source Control panel
```

### 3. Generate the commit message

Click the **✨** button in the Source Control panel header.

The message appears in an editable panel — review it, make any tweaks, then click **Apply to Commit** or press `Ctrl+Enter`.

---

## Usage

| Action | How |
|--------|-----|
| Generate message | Click **✨** in Source Control header |
| Apply message | Click **Apply to Commit** or `Ctrl+Enter` |
| Regenerate | Click **↺ Regenerate** in the preview panel |
| Cancel | Click **✕ Cancel** or press `Esc` |
| View history | Click the **Commit AI** icon in the Activity Bar |
| Re-apply old message | Click any item in the history panel |
| Copy from history | Hover the item → click the copy icon |
| Clear history | Click the 🗑 icon in the history panel header |
| Change API Key | `Ctrl+Shift+P` → `Commit AI: Set OpenAI API Key` |

---

## Extension Settings

Configure via `File → Preferences → Settings` and search for **Commit AI**:

| Setting | Default | Description |
|---------|---------|-------------|
| `commitAI.provider` | `openai` | `openai` or `ollama` |
| `commitAI.ollama.model` | `qwen2.5-coder:3b` | Downloaded local model |
| `commitAI.ollama.baseUrl` | `http://localhost:11434` | Ollama server URL |
| `commitAI.ollama.timeout` | `120` | Timeout in seconds |
| `commitAI.model` | `gpt-4o-mini` | OpenAI model to use |
| `commitAI.maxDiffLength` | `4000` | Max characters of diff sent to OpenAI |
| `commitAI.includeBody` | `true` | Include body for complex changes |
| `commitAI.temperature` | `0.3` | Creativity level (0 = deterministic, 1 = creative) |

---

## Project Structure

```
src/
├── extension.ts          # Entry point — registers commands and views
├── gitService.ts         # Reads staged diff, writes to SCM input box
├── openaiService.ts      # Calls OpenAI API, manages API key
├── commitPreviewPanel.ts # Webview panel for editing the generated message
└── historyProvider.ts    # TreeView provider for the history sidebar
```

---

## Development

```bash
# Install dependencies
npm install

# Build (development)
node esbuild.js

# Build (production / minified)
node esbuild.js --production

# Watch mode
node esbuild.js --watch

# Type-check only
npx tsc --noEmit

# Package as .vsix
npx vsce package --no-dependencies
```

---

## Privacy

- With OpenAI selected, your git diff is sent to OpenAI's API.
- With Ollama selected, your diff is sent only to the configured Ollama server. A local server with a local model keeps generation on that machine; remote servers or cloud models have different privacy implications.
- The API key is stored locally in VS Code's `SecretStorage` (OS Keychain).
- No data is stored or sent anywhere else.
- Review [OpenAI's privacy policy](https://openai.com/policies/privacy-policy) for details on how your data is handled.

---

## License

MIT © Daniel Boggiano

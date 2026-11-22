# SmarterCode DeepSeek
**Version: 0.0.47**

> **⚠️ IMPORTANT NOTE — Production & Preview Features**
>
> The **Copilot Integration** (using DeepSeek as a VS Code Language Model Chat Provider) is already at **production level** and ready for daily use.
>
> However, this extension also contains several **experimental features** that are still under active development:
>
> - **Vault & Iterative Prompt** — Persistent memory and the structured prompt webview are available as a **preview of what's coming**. These are functional but may see breaking changes as we refine them.
> - **Heavy Optimisations & Saved Prompts** — Major performance improvements and enhanced prompt management capabilities are in the pipeline.
>
> Feedback and contributions are welcome — they help shape the final features!

## Quick Start

1. Press **F1** and select **DeepSeek: Set API Key** — enter your DeepSeek API key when prompted.
2. Open VS Code Chat (`Ctrl+Shift+I`) and pick **DeepSeek V4 Flash** or **DeepSeek V4 Pro** from the model dropdown.
3. Start asking questions or requesting code changes — DeepSeek works just like Copilot.

> For the full feature set (vault memory, iterative prompts, sidebar explorer, and more), read the sections below.

> For more updates, subscribe to [zikalino.substack.com](https://zikalino.substack.com).

## Table of Contents

1. [Overview](#1-overview)
2. [Usage](#2-usage)
3. [Vault-Based Persistent Memory](#3-vault-based-persistent-memory)
4. [Iterative Prompt (Structured Interaction)](#4-iterative-prompt-structured-interaction)
5. [Sidebar Explorer](#5-sidebar-explorer)
6. [Writeback Engine (Auto-Apply Diff Patches)](#6-writeback-engine-auto-apply-diff-patches)
7. [Multi-Vault Architecture](#7-multi-vault-architecture)
8. [Configuration Reference](#8-configuration-reference)
9. [Commands Reference](#9-commands-reference)
10. [Architecture Overview](#10-architecture-overview)
11. [Build & Install](#11-build--install)

---

## 1. Overview

**SmarterCode DeepSeek** is a VS Code extension that brings DeepSeek's language models (V4 Flash & V4 Pro) directly into your editor. It goes beyond a simple chat wrapper by providing:

- **Copilot integration** — Use DeepSeek as your default model in VS Code Chat. Ask questions, request code changes, search your codebase — all from `Ctrl+Shift+I`.
- **Iterative Prompt** — A dedicated webview for structured prompts with memory files, file attachments, and iterative refinement loops.
- **File & code context** — Right-click any file or selected code in the editor and send it directly to DeepSeek.
- **Persistent project memory (Vault)** — An embedded vault of Markdown notes with tags and frontmatter that forms an evolving knowledge base for your project.
- **Tag-based context selection** — Tags let you control which vault notes are included in prompts.
- **Diff-based writeback** — DeepSeek can propose file changes as unified diffs, and the extension applies them automatically.

---

## 2. Usage

### Configuration — Copilot Integration Mode

API routing is handled automatically via the DeepSeek Copilot provider. No manual API key configuration is typically required.

To point to a different API endpoint (e.g., a self-hosted proxy), set `deepseek.apiEndpoint` in settings.

---

### Using with Copilot

After configuring your API key, the quickest way to start is through VS Code's built-in chat:

1. Open VS Code Chat — `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Shift+I` (macOS).
2. Select **DeepSeek V4 Flash** or **DeepSeek V4 Pro** from the model dropdown in the chat input.
3. Start typing your question

> DeepSeek V4 Flash is optimized for speed; V4 Pro offers deeper reasoning. Switch between them per conversation.

**What you can do in Copilot:**
- Ask questions about your codebase — DeepSeek uses VS Code tools to search, read, and understand your project.
- Request code changes — it can read files, propose edits, and explain the reasoning.
- Attach images — they're automatically described and injected into context.

---

### Working with Iterative Prompt

The **Iterative Prompt** (`DeepSeek: Iterative Prompt` from F1) is the extension's dedicated prompt webview. It's designed for structured interactions where you want to:

- Include **memory files** (vault notes tagged with relevant context).
- Attach **workspace files** as supporting context.
- **Iterate** on a prompt, refining it based on DeepSeek's responses.

**Quick start:**

1. Run **DeepSeek: Iterative Prompt** from the command palette.
2. The prompt webview opens with sections for Tags, Memory Files, User Prompt, and Attached Files.
3. Add tags from the sidebar vault explorer — they appear in the Tags section with all associated memory files.
4. Write your question in the User Prompt section (editable textarea).
5. Click **Send** — the response appears in a separate Response tab.
6. Save your prompt with the **Save** button — it's stored in `.vault/saved-prompts/`.
7. After the response, you can:
   - **Apply code changes** — if DeepSeek suggested unified diffs, the extension can apply them directly to your workspace files.
   - **Refine the prompt** — edit the User Prompt section and re-submit.
   - **Accept adjustment request** — if the model determines that the prompt needs refinement, it responds with an `adjustment-request` YAML block. The extension then prompts you for clarifications and restarts with an updated objective, added files, or additional context.

The webview includes interactive list sections for Tags, Memory Files, and TODO items — you can remove items with the ✕ button and toggle checkboxes in the TODO section.

---

### Working with Files from Explorer

You can quickly add files from the **File Explorer** to your Iterative Prompt:

- **Single file:** Right-click a file → **Add to Prompt** → The file is added to the active prompt (auto-creates one if needed).
- **Folder:** Right-click a folder → **Add to Prompt** → All `.md` files in that folder are added to Memory Files, with TODOs parsed into the TODO section.
- **Multi-select:** Select multiple files/folders, right-click → **Add to Prompt** → All selected items are attached.

### Working with Editor Selection

To get help on specific code:

1. Select the code in the editor.
2. Right-click → **Add to Prompt**.
3. If no prompt is open, one is created automatically with the selected code as the User Prompt.

---

### Working with Memory Files (Vault)

The **Vault** is your project's persistent memory — a collection of Markdown notes stored in `.vault/` at your workspace root. These notes carry YAML frontmatter (tags, type, related IDs) and serve as long-term context for DeepSeek.

**Creating a note:**

Create a `.md` file anywhere in `.vault/` with frontmatter:

```markdown
---
id: api-design
tags: [backend, architecture]
type: decision
---

# API Design Decision

We chose REST over GraphQL because...
```

The vault is auto-indexed — new notes are picked up immediately without a restart.

**Using notes in prompts:**

- In the **Iterative Prompt**, select relevant tags in the Tags step — all notes with those tags are injected as context.
- Add vault files from the sidebar via **Add to Prompt** — they appear under Memory Files.

See [§3 — Vault-Based Persistent Memory](#3-vault-based-persistent-memory) for the full format reference and indexing details.

---

### Working with TODOs

The extension parses TODO items from vault Markdown files that contain sections matching "next steps", "todo", or "requests". Both `- [x]` (done) and `-` (pending) items are recognized.

**In the sidebar:** Expand the **TODOs** section to see items grouped by parent folder.

**Using TODOs in prompts:**
- Right-click a TODO item → **Add to Prompt**: adds the TODO text to the TODO section and the parent file to Memory Files.
- Adding a vault file or folder also parses TODOs from the content and adds them automatically.

---

### DeepSeek Request Log & Token Costs

The extension logs all DeepSeek API activity to the **DeepSeek** output channel.

**Viewing logs:**

1. Run **DeepSeek: Browse Logs** from the command palette.
2. This opens the `DeepSeek` output channel with timestamped entries for each request.
3. Logs include request summaries, token usage, and cost estimates.

Per-request entries are persisted to `.smartercode/deepseek-history/` in the workspace only when `deepseek-copilot.historyLogging` is enabled (off by default, since it writes to disk on every turn). The request log browser reads from that folder.

**Understanding costs:**

Each log entry shows:
- **Model used** — V4 Flash vs V4 Pro (different pricing).
- **Input tokens** — How many tokens were sent (prompt + context).
- **Output tokens** — How many tokens were generated (response).
- **Estimated cost** — Calculated based on model pricing.

This is useful for tracking usage and ensuring you're not exceeding API budget. You can adjust the model selection and context size (via `deepseek.maxContextNotes` and `deepseek.maxNoteLength`) to control costs.

For deeper diagnostics, set `deepseek-copilot.debugMode` to `"verbose"`. To also capture the raw Copilot and DeepSeek payloads in the workspace `.dump/` folder, enable `deepseek-copilot.dumpRequests` — it writes several megabytes per turn, so it is off by default, and retention keeps roughly the newest 100 files of each kind.

---

## 3. Vault-Based Persistent Memory

The vault is an **embedded Obsidian-style Markdown note collection** that serves as the project's persistent memory. Every note is a `.md` file with YAML frontmatter, stored in a configurable vault directory (default: `.vault/` at the workspace root).

### Vault Structure

```
.vault/
├── 01-memory-ops/       # Starter folder: operational memory
├── 10-projects/         # Starter folder: project notes
├── 20-shared-systems/   # Starter folder: shared system documentation
├── saved-prompts/       # Saved Iterative Prompt markdown files
├── reports/             # Response outputs from DeepSeek
└── *.md                 # Any Markdown note files
```

### Note Format

```markdown
---
id: my-note
tags: [architecture, backend]
type: design-doc
related: [other-note]
---

# My Note

Content here...
```

### Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (defaults to filename without extension) |
| `tags` | string[] | Tags for context selection and indexing |
| `type` | string | Optional type classification (e.g., `design-doc`, `decision`) |
| `related` | string[] | Optional related note IDs |

### Vault Indexing

On startup, the extension scans all `.md` files in the vault and builds three indexes:

- **Tag Index** — Maps each tag to the list of file paths that carry it.
- **ID Index** — Maps each note ID to its file path.
- **Type Index** — Maps each type value to file paths (reserved for future use).

The vault is **auto-reindexed** whenever files are added, removed, or modified via a `FileSystemWatcher`.

### System Prompt from Vault

You can place a custom system prompt in your vault and point to it via the `deepseek.systemPromptPath` setting. The path is relative to the vault root.

---

## 4. Iterative Prompt (Structured Interaction)

The **Iterative Prompt** (`DeepSeek: Iterative Prompt` command) is the extension's flagship interaction mode. It opens a webview that collects context tags, memory files, and attached files, then submits to DeepSeek with support for iterative refinement.

### Webview Layout

The prompt webview is a markdown-based editor with the following sections:

- **System Prompt** — The system instructions sent to the model.
- **Tags** — Interactive list of @tags. Click ✕ to remove. Adding a tag from the sidebar also adds its associated memory files.
- **Memory Files** — Interactive list of vault files included as context. Click ✕ to remove. Vault folders are expanded to all .md files when added.
- **TODO** — Interactive list with checkboxes. Click a checkbox to toggle, ✕ to remove. TODOs are automatically parsed from memory files when they're added.
- **User Prompt** — An editable textarea where you write your question or instruction.
- **Attached Files** — Non-vault files added as additional context.

### Save Button

The prompt tab includes a **Save** button that saves the current prompt content to `{vaultRoot}/saved-prompts/` as a `.md` file with front matter. Saved prompts appear in the sidebar under **Saved Prompts** — click to reopen as an Iterative Prompt, or right-click to view the markdown or delete.

### Iterative Refinement Loop

If DeepSeek's response contains a YAML block with `adjustment-request` including:
- `updated-objective`
- `files-needed`
- `clarifications-needed`

...the extension prompts for clarifications and restarts, enabling an **adjustment loop** where you iteratively refine the objective and files until satisfied.

---

## 5. Sidebar Explorer

The **DeepSeek Explorer** sidebar (activity bar icon) provides a hierarchical view of:

### Vault Files
- Tree view of all Markdown notes in the workspace vault, organized by folder structure.
- Click to open a note in the editor.
- Right-click menu: **Add to Prompt**, **Delete**.

### Global Vault Files (if configured)
- Separate tree section for notes from an external global vault.
- Same interactions as workspace vault files.

### Tags
- Flat list of all `@tag` entries found in vault notes (both workspace and global).
- Click a tag to see its associated notes.
- Right-click: **Add to Prompt**.

### TODOs
- Parses `project-memory.md` files in the vault for TODO sections.
- Recognizes `- [x]` (done) and `-` (pending) checklist items.
- Groups by parent folder for easy navigation.
- Click to open the file at the specific line.
- Right-click: **Add to Prompt** (adds all TODOs from that file + the file to Memory Files).

### Saved Prompts
- Lists all `.md` prompt files from `{vaultRoot}/saved-prompts/`.
- Click to reopen as an Iterative Prompt with that content.
- Right-click menu: **Add to Prompt**, **View Markdown**, **Delete**.

---

## 6. Writeback Engine (Auto-Apply Diff Patches)

The **Writeback Engine** enables DeepSeek to propose and apply changes to workspace files automatically. When DeepSeek outputs a unified diff inside a `diff` fenced code block, the engine parses and applies it.

### Supported Formats

**Unified Diff:**
```diff
--- a/src/file.ts
+++ b/src/file.ts
@@ -10,6 +10,7 @@
 some context line
+new line
 another context line
```

**Note Creation:**
```
[CREATE_NOTE id=my-note tags=architecture,backend type=decision]
# Note content here
[END_NOTE]
```

### How It Works

1. Parse fenced `diff` blocks from the response.
2. Parse unified diff hunks with context matching.
3. Apply hunks in **reverse order** (bottom-to-top) to maintain line numbers.
4. Handle edge cases like new file creation (`/dev/null → new path`) and file deletion.

### Response Storage

All responses are saved to `{vaultRoot}/reports/` as:
- `response-raw.txt` — raw markdown response
- `response-{timestamp}.html` — styled HTML rendering

---

## 7. Multi-Vault Architecture

The extension supports **two vaults simultaneously**:

### Workspace Vault (default)
- Located at `{workspaceRoot}/.vault` (configurable).
- Scoped to the current project.
- Version-control friendly.

### Global Vault (optional)
- Configured via `deepseek.globalVaultPath`.
- Absolute path to an external vault outside the workspace.
- Notes appear under "Global Vault Files" in the sidebar.
- Tags are **merged** with workspace vault tags for context selection.

### Use Cases
- **Workspace vault** — Project-specific decisions, architecture notes, API documentation.
- **Global vault** — Personal coding standards, reusable templates, cross-project conventions.

---

## 8. Configuration Reference

All settings are under the `deepseek.*` and `deepseek-copilot.*` namespaces.

### Core Settings (`deepseek.*`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `deepseek.mode` | `"api"` \| `"local"` | `"api"` | Inference mode. |
| `deepseek.apiEndpoint` | string | `https://api.deepseek.com/v1/chat/completions` | API endpoint override. |
| `deepseek.model` | string | `"deepseek-v4-flash"` | Model name to use. |
| `deepseek.vaultRoot` | string | `".vault"` | Vault path relative to workspace root. |
| `deepseek.globalVaultPath` | string | `""` | Absolute path to an external global vault. |
| `deepseek.maxContextNotes` | number (1–50) | `10` | Max vault notes injected per turn. |
| `deepseek.maxNoteLength` | number (100–32000) | `4000` | Max chars per note before truncation. |
| `deepseek.systemPromptPath` | string | `""` | Path to a custom system prompt file inside vault. |

### Copilot Debug Settings (`deepseek-copilot.*`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `deepseek-copilot.debugMode` | `"minimal"` \| `"metadata"` \| `"verbose"` | `"minimal"` | Controls request diagnostics and dump file generation. |
| `deepseek-copilot.dumpRequests` | boolean | `false` | Also write raw Copilot/DeepSeek request and response payloads to the workspace `.dump/` folder (several MB per turn; retention keeps roughly the newest 100 files of each kind). |
| `deepseek-copilot.historyLogging` | boolean | `false` | Persist a JSON entry per DeepSeek response to `.smartercode/deepseek-history/` (newest 200 entries kept; bodies truncated to 200,000 chars). |

### Internal Copilot Settings (advanced)

| Setting | Namespace | Description |
|---------|-----------|-------------|
| `baseUrl` | `deepseek-copilot` | API base URL for the deepseek-copilot provider. |
| `maxTokens` | `deepseek-copilot` | Max output tokens (0 = model default). |
| `experimental.stabilizeToolList` | `deepseek-copilot` | Enable tool list stabilization across turns. |
| `visionModel` | `deepseek-copilot` | Model used for vision proxy image descriptions. |

---

## 9. Commands Reference

Commands marked with 🔍 are accessible from the **F1 command palette**. Internal commands are hidden from the palette but work via context menus, sidebar interactions, or programmatic calls.

### F1-Accessible Commands

| Command ID | Title | Description |
|-----------|-------|-------------|
| 🔍 `deepseek.createPrompt` | DeepSeek: Iterative Prompt | Open the prompt webview with context tags, memory files, and DeepSeek submission. |
| 🔍 `deepseek.showLogs` | DeepSeek: Browse Logs | Open the DeepSeek output log channel. |
| 🔍 `deepseek.configureDeepSeek` | DeepSeek: Configure Settings | Open VS Code settings for this extension. |
| 🔍 `deepseek.createVault` | DeepSeek: Create Vault | Initialize a new vault in the workspace. |

### Internal Commands (hidden from F1 palette)

| Command ID | Title | Trigger Surface |
|-----------|-------|----------------|
| `deepseek.addToPrompt` | Add To Prompt | Explorer right-click, sidebar right-click |
| `deepseek.sendPromptToDeepSeek` | Send Prompt To DeepSeek | Programmatic (sends prompt webview content to API) |
| `deepseek.sidebar.refresh` | Refresh Sidebar Explorer | Sidebar toolbar button |
| `deepseek.sidebar.filter` | Filter Vault Explorer | Sidebar search icon |
| `deepseek.sidebar.clearFilter` | Clear Vault Explorer Filter | Programmatic |
| `deepseek.explorerDeleteItem` | Delete | Sidebar item context menu |
| `deepseek.explorerShowMenu` | More Actions | Sidebar item inline button |
| `deepseek.openVaultFile` | Open Vault File | Sidebar file click |
| `deepseek.openTodoItem` | Open Todo File at Line | Sidebar click |
| `deepseek.openSavedWorkflow` | Open Saved Prompt | Sidebar saved prompt click |
| `deepseek.saveWorkflowToVault` | Save Prompt to Vault | Sidebar context menu |
| `deepseek.showTaggedFiles` | Show Tagged Files | Sidebar tag click |
| `deepseek.api.submitToDeepSeek` | Submit Context to DeepSeek | Programmatic (used by Iterative Prompt send) |
| `deepseek.api.addRequestText` | Add Request Text to Chat Draft | Programmatic |

---

## 10. Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    VS Code Extensions Host             │
│                                                        │
│  ┌──────────────────────────────────────────────┐     │
│  │              extension.ts (activate)          │     │
│  │                                                │     │
│  │  ┌─────────────┐  ┌──────────────────┐       │     │
│  │  │ AuthManager  │  │ VaultManager      │       │     │
│  │  │ (auth.ts)    │  │ (vaultManager.ts) │       │     │
│  │  └──────┬──────┘  └────────┬─────────┘       │     │
│  │         │                  │                   │     │
│  │  ┌──────▼──────┐  ┌───────▼────────┐         │     │
│  │  │ DeepSeek    │  │ IndexEngine     │         │     │
│  │  │ ChatProvider│  │ (indexEngine.ts)│         │     │
│  │  │(provider/   │  └───────┬────────┘         │     │
│  │  │  index.ts)  │          │                   │     │
│  │  └──────┬──────┘  ┌───────▼────────┐         │     │
│  │         │         │ ContextSelector │         │     │
│  │         │         │(contextSelector)│         │     │
│  │         │         └───────┬────────┘         │     │
│  │         │                 │                   │     │
│  │  ┌──────▼──────────────────▼────────┐         │     │
│  │  │   DeepSeekClient                  │         │     │
│  │  │   (deepseekClient.ts)             │         │     │
│  │  └──────────────┬───────────────────┘         │     │
│  │                 │                              │     │
│  │  ┌──────────────▼────────────┐                 │     │
│  │  │   WritebackEngine          │                 │     │
│  │  │   (writebackEngine.ts)     │                 │     │
│  │  └───────────────────────────┘                 │     │
│  │                                                │     │
│  │  ┌─────────────┐  ┌──────────────────┐        │     │
│  │ │ SidebarTree  │  │ Prompt Webview   │       │     │
│  │ │(sidebarTree) │  │(prompt-webview)  │       │     │
│  │  └─────────────┘  │      .ts)         │       │     │
│  │                    └──────────────────┘        │     │
│  └──────────────────────────────────────────────┘     │
│                                                        │
│  ┌──────────────────────────────────────────────┐     │
│  │         DeepSeek API (chat.deepseek.com)      │     │
│  │         or Local Inference Server              │     │
│  └──────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Dual Provider Architecture** — The extension registers both a `LanguageModelChatProvider` (for Copilot integration) and a standalone `DeepSeekClient` (for the Iterative Prompt). Each has independent configuration and request pipelines.

2. **Vault as File System** — The vault is stored as plain Markdown files on disk, making it version-control friendly and editable with any tool.

3. **Tag-Based Context Selection** — Tags provide explicit, user-controlled context selection for including relevant vault notes in prompts.

4. **Unified Diff Writeback** — Code changes are applied via unified diff patches parsed directly from model responses, enabling automated code modification with human oversight.

---

## 11. Build & Install

### Prerequisites
- Node.js 18+
- VS Code 1.85+

### Build

```bash
cd vscode-extensions/vscode-deepseek
npm install
npm run compile
```

### Package & Install

Run `build-install.bat` from the extension folder:

```bash
build-install.bat
```

This runs `vsce package` (which triggers `vscode:prepublish` → `precompile` → `compile`), then `code --install-extension` on the resulting `.vsix`.

If shared components have changed (`shared/vscode-components/`), `vsce package` automatically runs `prepare:shared-components` to materialize the latest build.

After install, reload VS Code:
`Ctrl+Shift+P` → **Developer: Reload Window**

### Extension Structure

```
vscode-deepseek/
├── src/
│   ├── extension.ts           # Activation, command registrations, DI wiring
│   ├── auth.ts                # API key management via SecretStorage
│   ├── consts.ts              # Constants & model definitions
│   ├── types.ts               # TypeScript types
│   ├── logger.ts              # Output channel logger
│   ├── i18n.ts                # Internationalization (Chinese/English)
│   ├── deepseekClient.ts      # Standalone DeepSeek API client
│   ├── vaultManager.ts        # Vault file management & frontmatter parsing
│   ├── indexEngine.ts         # Tag/id/type index building
│   ├── sidebarTree.ts         # DeepSeek Explorer tree provider
│   ├── writebackEngine.ts     # Unified diff parser & file patcher
│   ├── promptFile.ts          # Prompt markdown file creation & management
│   ├── client/
│   │   ├── core.ts            # Copilot provider HTTP client
│   │   └── error.ts           # Error handling utilities
│   └── provider/
│       ├── index.ts           # DeepSeekChatProvider (Copilot integration)
│       ├── convert.ts         # Message/tool format conversion
│       ├── schema.ts          # Schema validation
│       ├── debug/             # Request dumping & diagnostics
│       ├── replay/            # Conversation replay engine
│       ├── tools/             # Tool stabilization & limits
│       └── vision/            # Vision proxy for image input
├── vendor/                    # Materialized shared components
├── imgs/                      # Extension icons
├── scripts/                   # Build scripts
├── package.json
├── tsconfig.json
└── build-install.bat
```

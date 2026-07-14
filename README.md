# Claude Code HTML Export

A lightweight companion extension for the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) VS Code extension that exports chat sessions to self-contained `.html` files.

## Install

Download `claude-code-html-export-0.1.0.vsix` from the [latest release](https://github.com/JTruax/claude-code-html-export/releases/latest), then:

```sh
code --install-extension claude-code-html-export-0.1.0.vsix
```

Reload the window and the **Session History** section appears in the Claude Code sidebar. (To build it yourself instead, see [Development](#development).)

## Features

- **Session History view** — appears as a collapsible section inside the Claude Code sidebar, listing every project and session found under `~/.claude/projects/`. Your current workspace's project is listed first and expanded.
- **One-click export** — each session row has an inline download icon. Click it, pick a location (defaults to `~/Downloads/<session-title>.html`), and open the result in your browser.
- **Full transcript** — user and assistant turns render as a clean, readable document; thinking, tool calls, and tool results are included as labeled sections. Dark and light mode supported via `prefers-color-scheme`.
- **Built for re-ingestion, not just reading** — the export is designed for a second audience: another AI reading it back as reference for what happened in a session. Turn boundaries, tool calls, and thinking blocks use a consistent heading hierarchy (`h1` session → `h2` turn → `h3` tool/thinking/command) and semantic attributes (`data-role`, `data-block`, `data-tool`, ISO-8601 `<time>` stamps) so the structure survives being parsed back out of the HTML — a markdown heading written inside a message is automatically demoted so it's never mistaken for a turn boundary.
- **Command palette fallback** — `Claude History: Export Session to HTML…` works even without the tree view.

## Why a separate view?

The Claude Code extension renders its own history list inside a webview, which other extensions can't add buttons to. This extension contributes its own tree view into the Claude Code sidebar container instead, directly below the chat panel.

## Notes

- The exported HTML is fully self-contained (inline CSS, no external requests, no JavaScript) and works offline from disk.
- All transcript content is HTML-escaped, and links/images are restricted to a safe URL allowlist (`http(s)`, `mailto`, relative links, and base64 images) — a page renders untrusted content from your sessions (web content, file contents, tool output) directly in a browser, so it's treated as such. A strict Content-Security-Policy is set on the document itself.
- Subagent (sidechain) transcripts and internal metadata entries are omitted from exports.
- Tool inputs/outputs longer than 50 KB are truncated with a note.

## Development

```sh
npm install
npm run compile   # typecheck + bundle to dist/
npm run package   # build .vsix via vsce
```

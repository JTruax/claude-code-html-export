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
- **Full transcript** — user and assistant messages render as chat bubbles; thinking, tool calls, and tool results are included as collapsible sections. Dark and light mode supported via `prefers-color-scheme`.
- **Command palette fallback** — `Claude History: Export Session to HTML…` works even without the tree view.

## Why a separate view?

The Claude Code extension renders its own history list inside a webview, which other extensions can't add buttons to. This extension contributes its own tree view into the Claude Code sidebar container instead, directly below the chat panel.

## Notes

- The exported HTML is fully self-contained (inline CSS, no external requests) and all transcript content is HTML-escaped.
- Subagent (sidechain) transcripts and internal metadata entries are omitted from exports.
- Tool inputs/outputs longer than 50 KB are truncated with a note.

## Development

```sh
npm install
npm run compile   # typecheck + bundle to dist/
npm run package   # build .vsix via vsce
```

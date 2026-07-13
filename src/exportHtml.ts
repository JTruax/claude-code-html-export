import { marked } from 'marked';
import { ContentBlock, SessionData, TranscriptEntry } from './sessionStore';

const MAX_BLOCK_CHARS = 50_000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Transcripts contain arbitrary code and markup. Render markdown but never
// pass raw HTML through: html tokens are re-emitted escaped.
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token: { text?: string; raw?: string }): string {
      return escapeHtml(token.text ?? token.raw ?? '');
    },
  },
});

function md(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_BLOCK_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_BLOCK_CHARS), truncated: true };
}

function pre(content: string, cls = ''): string {
  const { text, truncated } = truncate(content);
  const note = truncated ? '<div class="trunc">… truncated for export</div>' : '';
  return `<pre class="${cls}"><code>${escapeHtml(text)}</code></pre>${note}`;
}

function fmtTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: ContentBlock) => {
        if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b && b.type === 'image') return '[image]';
        return JSON.stringify(b);
      })
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content, null, 2);
}

interface CommandParts {
  name?: string;
  args?: string;
  stdout?: string;
  caveatOnly: boolean;
}

function parseCommandText(s: string): CommandParts | undefined {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(s)?.[1]?.trim();
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim();
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(s)?.[1];
  const hasCaveat = s.includes('<local-command-caveat>');
  if (!name && stdout === undefined && !hasCaveat) return undefined;
  return { name, args, stdout, caveatOnly: hasCaveat && !name && stdout === undefined };
}

function renderCommandChip(parts: CommandParts): string {
  const pieces: string[] = [];
  if (parts.name) {
    const label = parts.args ? `${parts.name} ${parts.args}` : parts.name;
    pieces.push(`<div class="chip">ran <code>${escapeHtml(label)}</code></div>`);
  }
  if (parts.stdout && parts.stdout.trim()) {
    pieces.push(
      `<details class="tool"><summary>Command output</summary>${pre(parts.stdout.trim())}</details>`
    );
  }
  return pieces.join('\n');
}

function renderUserString(text: string): string {
  const cmd = parseCommandText(text);
  if (cmd) return cmd.caveatOnly ? '' : renderCommandChip(cmd);
  return `<div class="bubble">${md(text)}</div>`;
}

function renderAssistantBlocks(
  blocks: ContentBlock[],
  resultsById: Map<string, ContentBlock>
): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      out.push(`<div class="bubble">${md(b.text)}</div>`);
    } else if (b.type === 'thinking' && b.thinking) {
      out.push(
        `<details class="thinking"><summary>Thinking</summary><div class="thinking-body">${md(
          b.thinking
        )}</div></details>`
      );
    } else if (b.type === 'tool_use') {
      const name = escapeHtml(b.name ?? 'tool');
      const input =
        b.input === undefined ? '' : pre(JSON.stringify(b.input, null, 2), 'tool-input');
      const result = b.id ? resultsById.get(b.id) : undefined;
      let resultHtml = '';
      if (result) {
        const text = toolResultText(result.content).trim();
        const errCls = result.is_error ? ' error' : '';
        if (text) {
          resultHtml = `<div class="tool-result${errCls}"><div class="tool-result-label">${
            result.is_error ? 'Error' : 'Result'
          }</div>${pre(text)}</div>`;
        }
      }
      out.push(
        `<details class="tool"><summary>&#128295; ${name}</summary>${input}${resultHtml}</details>`
      );
    }
  }
  return out.join('\n');
}

function renderUserBlocks(blocks: ContentBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      out.push(renderUserString(b.text));
    }
    // tool_result blocks are rendered inline with their tool_use, not here
  }
  return out.filter(Boolean).join('\n');
}

function renderEntryBody(
  entry: TranscriptEntry,
  resultsById: Map<string, ContentBlock>
): string {
  if (typeof entry.content === 'string') {
    return entry.type === 'user'
      ? renderUserString(entry.content)
      : `<div class="bubble">${md(entry.content)}</div>`;
  }
  return entry.type === 'assistant'
    ? renderAssistantBlocks(entry.content, resultsById)
    : renderUserBlocks(entry.content);
}

/** Consecutive entries from the same speaker render as one message group. */
function renderMessages(
  entries: TranscriptEntry[],
  resultsById: Map<string, ContentBlock>
): string {
  const out: string[] = [];
  let groupType: 'user' | 'assistant' | undefined;
  let groupTime: string | undefined;
  let groupBodies: string[] = [];

  const flush = () => {
    if (!groupType || groupBodies.length === 0) return;
    const who = groupType === 'user' ? 'You' : 'Claude';
    const time = fmtTime(groupTime);
    out.push(`<div class="msg ${groupType}">
  <div class="meta"><span class="who">${who}</span>${time ? `<span class="time">${escapeHtml(time)}</span>` : ''}</div>
  ${groupBodies.join('\n')}
</div>`);
    groupBodies = [];
  };

  for (const entry of entries) {
    const body = renderEntryBody(entry, resultsById);
    if (!body.trim()) continue;
    if (entry.type !== groupType) {
      flush();
      groupType = entry.type;
      groupTime = entry.timestamp;
    }
    groupBodies.push(body);
  }
  flush();
  return out.join('\n');
}

export function renderSessionHtml(session: SessionData): string {
  const resultsById = new Map<string, ContentBlock>();
  for (const entry of session.entries) {
    if (entry.type !== 'user' || !Array.isArray(entry.content)) continue;
    for (const b of entry.content) {
      if (b.type === 'tool_result' && b.tool_use_id) resultsById.set(b.tool_use_id, b);
    }
  }

  const messages = renderMessages(session.entries, resultsById);

  const title = escapeHtml(session.title);
  const headerRows: string[] = [];
  if (session.cwd) headerRows.push(`<div><span>Project</span><code>${escapeHtml(session.cwd)}</code></div>`);
  if (session.gitBranch) headerRows.push(`<div><span>Branch</span><code>${escapeHtml(session.gitBranch)}</code></div>`);
  if (session.model) headerRows.push(`<div><span>Model</span><code>${escapeHtml(session.model)}</code></div>`);
  headerRows.push(`<div><span>Session</span><code>${escapeHtml(session.sessionId)}</code></div>`);
  headerRows.push(`<div><span>Exported</span>${escapeHtml(new Date().toLocaleString())}</div>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  --bg: #f7f7f5; --fg: #1a1a18; --muted: #6b6b66; --border: #e3e3de;
  --user-bg: #e8eefc; --assistant-bg: #ffffff; --chip-bg: #eeeee9;
  --code-bg: #f0f0ec; --pre-bg: #f4f4f0; --accent: #b45309; --error: #b91c1c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1e1c; --fg: #e6e6e2; --muted: #94948e; --border: #3a3a36;
    --user-bg: #2b3550; --assistant-bg: #272723; --chip-bg: #2e2e2a;
    --code-bg: #2e2e2a; --pre-bg: #232320; --accent: #f59e0b; --error: #f87171;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
header { border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
header h1 { font-size: 22px; margin: 0 0 12px; }
.info { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
.info span { display: inline-block; min-width: 72px; font-weight: 600; }
.msg { margin: 16px 0; }
.msg .meta { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.msg .who { font-weight: 700; }
.msg .time { margin-left: 8px; }
.msg.user .who { color: #2563eb; }
.msg.assistant .who { color: var(--accent); }
.bubble {
  background: var(--assistant-bg); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px; overflow-wrap: break-word;
}
.msg.user .bubble { background: var(--user-bg); }
.bubble > :first-child { margin-top: 0; }
.bubble > :last-child { margin-bottom: 0; }
.chip {
  display: inline-block; background: var(--chip-bg); color: var(--muted);
  border: 1px solid var(--border); border-radius: 999px;
  font-size: 12px; padding: 2px 12px; margin: 2px 0;
}
details { margin: 6px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--assistant-bg); }
details summary {
  cursor: pointer; padding: 6px 12px; font-size: 13px; color: var(--muted);
  user-select: none;
}
details[open] summary { border-bottom: 1px solid var(--border); }
details > *:not(summary) { margin: 8px 12px; }
details.thinking summary { font-style: italic; }
.thinking-body { color: var(--muted); font-size: 14px; }
pre {
  background: var(--pre-bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.5;
}
pre code { background: none; padding: 0; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--code-bg); border-radius: 4px; padding: 1px 5px; font-size: 0.9em;
}
.tool-result-label { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
.tool-result.error .tool-result-label { color: var(--error); }
.trunc { font-size: 12px; color: var(--muted); font-style: italic; margin: 4px 12px; }
blockquote { border-left: 3px solid var(--border); margin: 8px 0; padding: 0 12px; color: var(--muted); }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border); padding: 4px 10px; }
img { max-width: 100%; }
a { color: #2563eb; }
footer { margin-top: 40px; font-size: 12px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${title}</h1>
  <div class="info">${headerRows.join('\n')}</div>
</header>
${messages}
<footer>Exported from Claude Code &middot; ${session.entries.length} transcript entries</footer>
</div>
</body>
</html>
`;
}

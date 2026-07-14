import { marked, Tokens } from 'marked';
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

/**
 * Transcripts carry untrusted text (web pages, file contents, tool output) into
 * a file the user opens in a browser. Only http(s)/mailto and relative targets
 * survive; everything else — `javascript:`, `vbscript:`, `data:` documents — is
 * dropped. Scheme detection runs on a copy stripped of whitespace and control
 * characters, which are otherwise legal inside a URL scheme and can hide one.
 */
function safeUrl(href: string | null | undefined, allowDataImage = false): string | undefined {
  const raw = (href ?? '').trim();
  const probe = raw.replace(/[\u0000-\u0020\u007f]/g, '');
  if (!probe) return undefined;
  if (/^(?:https?:|mailto:)/i.test(probe)) return raw;
  if (allowDataImage && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(probe)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe)) return undefined;
  return raw;
}

// Render markdown, but never let raw HTML through: html tokens are re-emitted escaped.
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token: { text?: string; raw?: string }): string {
      return escapeHtml(token.text ?? token.raw ?? '');
    },
    link(token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens);
      const href = safeUrl(token.href);
      if (!href) return text;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} rel="noreferrer">${text}</a>`;
    },
    image(token: Tokens.Image): string {
      const alt = escapeHtml(token.text ?? '');
      const src = safeUrl(token.href, true);
      if (!src) return alt;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<img src="${escapeHtml(src)}" alt="${alt}"${title}>`;
    },
    /**
     * The document outline belongs to the transcript: h1 session, h2 turn, h3
     * tool call. A `##` inside a message is prose, not a turn boundary, so push
     * message headings below that floor — otherwise anything reading the outline
     * (or flattening the page back to markdown) mistakes one for the other.
     */
    heading(this: any, token: Tokens.Heading): string {
      const level = Math.min(token.depth + 3, 6);
      return `<h${level}>${this.parser.parseInline(token.tokens)}</h${level}>\n`;
    },
  },
});

function md(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function pre(content: string): string {
  const truncated = content.length > MAX_BLOCK_CHARS;
  const text = truncated ? content.slice(0, MAX_BLOCK_CHARS) : content;
  const note = truncated ? '\n<p class="note">Truncated for export.</p>' : '';
  return `<pre><code>${escapeHtml(text)}</code></pre>${note}`;
}

/** Local time as `YYYY-MM-DD HH:MM` — sortable, unambiguous, and locale-independent. */
function fmtTime(ts?: string): { display: string; iso: string } | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    display: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes()
    )}`,
    iso: d.toISOString(),
  };
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

function label(text: string, isError = false): string {
  return `<p class="label${isError ? ' error' : ''}">${text}</p>`;
}

function renderToolResult(result: ContentBlock): string {
  const text = toolResultText(result.content).trim();
  if (!text) return '';
  const err = result.is_error === true;
  return `\n${label(err ? 'Error' : 'Result', err)}\n${pre(text)}`;
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

function renderCommand(parts: CommandParts): string {
  const out: string[] = [];
  if (parts.name) {
    const label = parts.args ? `${parts.name} ${parts.args}` : parts.name;
    out.push(`<p class="note">Ran <code>${escapeHtml(label)}</code></p>`);
  }
  if (parts.stdout && parts.stdout.trim()) {
    out.push(
      `<section data-block="command">\n<h3>Command output</h3>\n${pre(parts.stdout.trim())}\n</section>`
    );
  }
  return out.join('\n');
}

function renderUserText(text: string): string {
  const cmd = parseCommandText(text);
  if (cmd) return cmd.caveatOnly ? '' : renderCommand(cmd);
  return md(text);
}

function renderAssistantBlocks(
  blocks: ContentBlock[],
  results: Map<string, ContentBlock>,
  consumed: Set<string>
): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      out.push(md(b.text));
    } else if (b.type === 'thinking' && b.thinking) {
      out.push(`<section data-block="thinking">\n<h3>Thinking</h3>\n${md(b.thinking)}\n</section>`);
    } else if (b.type === 'tool_use') {
      const name = escapeHtml(b.name ?? 'tool');
      const input =
        b.input === undefined
          ? ''
          : `\n${label('Input')}\n${pre(JSON.stringify(b.input, null, 2))}`;
      const result = b.id ? results.get(b.id) : undefined;
      if (b.id) consumed.add(b.id);
      out.push(
        `<section data-block="tool" data-tool="${name}">\n<h3>Tool: ${name}</h3>${input}${
          result ? renderToolResult(result) : ''
        }\n</section>`
      );
    }
  }
  return out.join('\n');
}

/**
 * tool_result blocks normally render inside the tool_use section that requested
 * them. A result whose tool_use never made it into the transcript (a torn write,
 * a filtered entry) would otherwise vanish, so emit it standalone.
 */
function renderUserBlocks(blocks: ContentBlock[], consumed: Set<string>): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      out.push(renderUserText(b.text));
    } else if (b.type === 'tool_result' && b.tool_use_id && !consumed.has(b.tool_use_id)) {
      const body = renderToolResult(b);
      if (body) out.push(`<section data-block="tool">\n<h3>Tool result</h3>${body}\n</section>`);
    }
  }
  return out.filter(Boolean).join('\n');
}

function renderEntryBody(
  entry: TranscriptEntry,
  results: Map<string, ContentBlock>,
  consumed: Set<string>
): string {
  if (typeof entry.content === 'string') {
    return entry.type === 'user' ? renderUserText(entry.content) : md(entry.content);
  }
  return entry.type === 'assistant'
    ? renderAssistantBlocks(entry.content, results, consumed)
    : renderUserBlocks(entry.content, consumed);
}

/** Consecutive entries from the same speaker collapse into one <article>. */
function renderTurns(entries: TranscriptEntry[], results: Map<string, ContentBlock>): string {
  const out: string[] = [];
  const consumed = new Set<string>();
  let role: 'user' | 'assistant' | undefined;
  let time: string | undefined;
  let bodies: string[] = [];

  const flush = () => {
    if (!role || bodies.length === 0) return;
    const t = fmtTime(time);
    const stamp = t ? ` <time datetime="${escapeHtml(t.iso)}">${t.display}</time>` : '';
    const heading = role === 'user' ? 'User' : 'Claude';
    out.push(
      `<article data-role="${role}">\n<h2>${heading}${stamp}</h2>\n${bodies.join('\n')}\n</article>`
    );
    bodies = [];
  };

  for (const entry of entries) {
    const body = renderEntryBody(entry, results, consumed);
    if (!body.trim()) continue;
    if (entry.type !== role) {
      flush();
      role = entry.type;
      time = entry.timestamp;
    }
    bodies.push(body);
  }
  flush();
  return out.join('\n\n');
}

// No script anywhere in the document, so lock it down: the only thing the page
// may load is an inline stylesheet and an image.
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'";

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a18;--muted:#6b6b66;--line:#e2e2dc;--pre:#f5f5f1;--err:#b3261e;--link:#0b5cad}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1a;--fg:#e6e6e2;--muted:#9b9b94;--line:#383834;--pre:#252522;--err:#f2837a;--link:#79b8ff}}
body{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 5rem;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,sans-serif;overflow-wrap:break-word}
h1{font-size:1.6rem;line-height:1.3;margin:0 0 1rem}
h2{margin:2.5rem 0 .75rem;font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:.35rem}
h2 time{float:right;font-weight:400;letter-spacing:0;text-transform:none}
h3{margin:1.25rem 0 .5rem;font-size:.9rem}
h4,h5,h6{margin:1.25rem 0 .4rem;font-size:1rem;line-height:1.35}
h5{font-size:.95rem}
h6{font-size:.9rem;color:var(--muted)}
article[data-role=user] h2{color:var(--link)}
.label{margin:.6rem 0 .3rem;font-size:.7rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.label.error{color:var(--err)}
section{margin:1rem 0;padding-left:1rem;border-left:2px solid var(--line)}
section[data-block=thinking]{color:var(--muted);font-size:.95rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem;font-size:.85rem;color:var(--muted);margin:0}
dt{font-weight:600}
dd{margin:0}
pre{background:var(--pre);border:1px solid var(--line);border-radius:4px;padding:.7rem .8rem;overflow:auto;max-height:30rem;font-size:.8rem;line-height:1.5}
pre code{background:none;padding:0;font-size:inherit}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--pre);border-radius:3px;padding:.1em .35em;font-size:.875em}
blockquote{margin:.75rem 0;padding-left:.9rem;border-left:2px solid var(--line);color:var(--muted)}
table{border-collapse:collapse;display:block;overflow-x:auto;font-size:.9rem}
th,td{border:1px solid var(--line);padding:.3rem .6rem;text-align:left}
hr{border:0;border-top:1px solid var(--line);margin:1.5rem 0}
img{max-width:100%}
a{color:var(--link)}
.note{font-size:.8rem;color:var(--muted);font-style:italic}
footer{margin-top:3rem;font-size:.8rem;color:var(--muted)}
@media print{pre{max-height:none}}`;

export function renderSessionHtml(session: SessionData): string {
  const results = new Map<string, ContentBlock>();
  for (const entry of session.entries) {
    if (entry.type !== 'user' || !Array.isArray(entry.content)) continue;
    for (const b of entry.content) {
      if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b);
    }
  }

  const turns = renderTurns(session.entries, results);
  const title = escapeHtml(session.title);

  const meta: [string, string][] = [];
  if (session.cwd) meta.push(['Project', `<code>${escapeHtml(session.cwd)}</code>`]);
  if (session.gitBranch) meta.push(['Branch', `<code>${escapeHtml(session.gitBranch)}</code>`]);
  if (session.model) meta.push(['Model', `<code>${escapeHtml(session.model)}</code>`]);
  meta.push(['Session', `<code>${escapeHtml(session.sessionId)}</code>`]);
  meta.push(['Exported', fmtTime(new Date().toISOString())?.display ?? '']);
  const dl = meta.map(([k, v]) => `  <dt>${k}</dt>\n  <dd>${v}</dd>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${title}</title>
<style>
${CSS}
</style>
</head>
<body>
<header>
<h1>${title}</h1>
<dl>
${dl}
</dl>
</header>
<hr>
<main>
${turns}
</main>
<hr>
<footer>Exported from Claude Code · ${session.entries.length} transcript entries</footer>
</body>
</html>
`;
}

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface TranscriptEntry {
  type: 'user' | 'assistant';
  timestamp?: string;
  content: string | ContentBlock[];
  model?: string;
}

export interface SessionData {
  sessionId: string;
  filePath: string;
  title: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  entries: TranscriptEntry[];
}

export interface SessionMeta {
  sessionId: string;
  filePath: string;
  title: string;
  mtime: number;
  messageCount: number;
  cwd?: string;
}

export interface ProjectInfo {
  slug: string;
  dir: string;
  /** Real project path recovered from a session's `cwd` field, if any. */
  realPath?: string;
  latestMtime: number;
  sessionFiles: string[];
}

export function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Mirror of Claude Code's project-dir slug: every non-alphanumeric char becomes '-'. */
export function slugifyPath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const root = projectsRoot();
  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: ProjectInfo[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files: string[];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    let latest = 0;
    const sessionFiles: string[] = [];
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = await fsp.stat(full);
        latest = Math.max(latest, st.mtimeMs);
        sessionFiles.push(full);
      } catch {
        // file vanished between readdir and stat
      }
    }
    if (sessionFiles.length === 0) continue;
    projects.push({ slug: d.name, dir, latestMtime: latest, sessionFiles });
  }
  projects.sort((a, b) => b.latestMtime - a.latestMtime);
  return projects;
}

interface CacheEntry {
  mtime: number;
  size: number;
  meta: SessionMeta;
}

const metaCache = new Map<string, CacheEntry>();

function isCommandText(s: string): boolean {
  return (
    s.includes('<command-name>') ||
    s.includes('<local-command-caveat>') ||
    s.includes('<local-command-stdout>')
  );
}

/** First line of a user prompt, trimmed to a listable label. */
function promptLabel(s: string): string {
  const firstLine = s.trim().split('\n', 1)[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine;
}

async function scanFile(
  filePath: string,
  onEntry: (obj: Record<string, any>) => void
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: Record<string, any>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // tolerate torn/corrupt lines
      }
      onEntry(obj);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function getSessionMeta(filePath: string): Promise<SessionMeta> {
  const st = await fsp.stat(filePath);
  const cached = metaCache.get(filePath);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
    return cached.meta;
  }

  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;
  let cwd: string | undefined;
  let messageCount = 0;

  await scanFile(filePath, (obj) => {
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      aiTitle = obj.aiTitle;
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;
    if (obj.isMeta === true || obj.isSidechain === true) return;
    cwd = cwd ?? obj.cwd;
    messageCount++;
    if (!firstPrompt && obj.type === 'user') {
      const content = obj.message?.content;
      let text: string | undefined;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const block = content.find(
          (b: ContentBlock) => b.type === 'text' && typeof b.text === 'string'
        );
        text = block?.text;
      }
      if (text && !isCommandText(text)) firstPrompt = promptLabel(text);
    }
  });

  const sessionId = path.basename(filePath, '.jsonl');
  const meta: SessionMeta = {
    sessionId,
    filePath,
    title: aiTitle || firstPrompt || sessionId,
    mtime: st.mtimeMs,
    messageCount,
    cwd,
  };
  metaCache.set(filePath, { mtime: st.mtimeMs, size: st.size, meta });
  return meta;
}

export async function listSessions(project: ProjectInfo): Promise<SessionMeta[]> {
  const metas: SessionMeta[] = [];
  for (const f of project.sessionFiles) {
    try {
      metas.push(await getSessionMeta(f));
    } catch {
      // unreadable session file; skip it
    }
  }
  metas.sort((a, b) => b.mtime - a.mtime);
  return metas;
}

/** Full parse of one session for export. */
export async function loadSession(filePath: string): Promise<SessionData> {
  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  const entries: TranscriptEntry[] = [];

  await scanFile(filePath, (obj) => {
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      aiTitle = obj.aiTitle;
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;
    if (obj.isMeta === true || obj.isSidechain === true) return;
    const content = obj.message?.content;
    if (content === undefined || content === null) return;
    cwd = cwd ?? obj.cwd;
    gitBranch = gitBranch ?? obj.gitBranch;
    if (obj.type === 'assistant' && obj.message?.model) model = obj.message.model;
    if (!firstPrompt && obj.type === 'user' && typeof content === 'string' && !isCommandText(content)) {
      firstPrompt = promptLabel(content);
    }
    entries.push({
      type: obj.type,
      timestamp: obj.timestamp,
      content,
      model: obj.message?.model,
    });
  });

  const sessionId = path.basename(filePath, '.jsonl');
  return {
    sessionId,
    filePath,
    title: aiTitle || firstPrompt || sessionId,
    cwd,
    gitBranch,
    model,
    entries,
  };
}

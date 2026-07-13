import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { renderSessionHtml } from './exportHtml';
import {
  SessionMeta,
  listProjects,
  listSessions,
  loadSession,
  projectsRoot,
} from './sessionStore';
import { SessionNode, SessionsTreeProvider } from './treeProvider';

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\/\\:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'claude-session').slice(0, 80);
}

async function exportSession(meta: SessionMeta): Promise<void> {
  let html: string;
  let title: string;
  try {
    const session = await loadSession(meta.filePath);
    title = session.title;
    html = renderSessionHtml(session);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to read session: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      path.join(os.homedir(), 'Downloads', `${sanitizeFilename(title)}.html`)
    ),
    filters: { HTML: ['html'] },
    title: 'Export Claude Code Session',
  });
  if (!target) return;

  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to write file: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Exported "${title}" to ${path.basename(target.fsPath)}`,
    'Open in Browser',
    'Reveal in Finder'
  );
  if (choice === 'Open in Browser') {
    void vscode.env.openExternal(target);
  } else if (choice === 'Reveal in Finder') {
    void vscode.commands.executeCommand('revealFileInOS', target);
  }
}

async function exportViaPicker(): Promise<void> {
  const projects = await listProjects();
  if (projects.length === 0) {
    void vscode.window.showInformationMessage(
      `No Claude Code sessions found under ${projectsRoot()}`
    );
    return;
  }

  interface ProjectPick extends vscode.QuickPickItem {
    index: number;
  }
  const projectPick = await vscode.window.showQuickPick<ProjectPick>(
    projects.map((p, index) => ({
      label: p.slug.replace(/^-/, '').split('-').pop() || p.slug,
      description: `${p.sessionFiles.length} session${p.sessionFiles.length === 1 ? '' : 's'}`,
      detail: p.slug,
      index,
    })),
    { placeHolder: 'Select a project' }
  );
  if (!projectPick) return;

  const sessions = await listSessions(projects[projectPick.index]);
  interface SessionPick extends vscode.QuickPickItem {
    meta: SessionMeta;
  }
  const sessionPick = await vscode.window.showQuickPick<SessionPick>(
    sessions.map((meta) => ({
      label: meta.title,
      description: new Date(meta.mtime).toLocaleString(),
      detail: `${meta.messageCount} messages`,
      meta,
    })),
    { placeHolder: 'Select a session to export' }
  );
  if (!sessionPick) return;

  await exportSession(sessionPick.meta);
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SessionsTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeHtmlExport.sessions', provider),
    vscode.window.registerTreeDataProvider('claudeHtmlExport.sessionsSecondary', provider),
    vscode.commands.registerCommand('claudeHtmlExport.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('claudeHtmlExport.export', (node?: SessionNode) => {
      if (node?.meta) return exportSession(node.meta);
      return exportViaPicker();
    }),
    vscode.commands.registerCommand('claudeHtmlExport.exportPicker', () => exportViaPicker())
  );

  // Refresh the tree when session files change on disk.
  try {
    let timer: NodeJS.Timeout | undefined;
    const watcher = fs.watch(projectsRoot(), { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => provider.refresh(), 1000);
    });
    context.subscriptions.push({
      dispose: () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      },
    });
  } catch {
    // ~/.claude/projects doesn't exist yet; the refresh button still works
  }
}

export function deactivate(): void {}

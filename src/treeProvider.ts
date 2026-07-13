import * as path from 'path';
import * as vscode from 'vscode';
import {
  ProjectInfo,
  SessionMeta,
  getSessionMeta,
  listProjects,
  listSessions,
  slugifyPath,
} from './sessionStore';

export type Node = ProjectNode | SessionNode;

export interface ProjectNode {
  kind: 'project';
  project: ProjectInfo;
  isCurrentWorkspace: boolean;
}

export interface SessionNode {
  kind: 'session';
  meta: SessionMeta;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** realPath per project slug, recovered from session metadata. */
  private realPaths = new Map<string, string>();

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      const projects = await listProjects();
      const wsSlugs = new Set(
        (vscode.workspace.workspaceFolders ?? []).map((f) => slugifyPath(f.uri.fsPath))
      );
      // Recover the real project path from the newest session's cwd (cached scan).
      for (const p of projects) {
        if (this.realPaths.has(p.slug)) continue;
        const newest = [...p.sessionFiles].sort().pop();
        try {
          const meta = await getSessionMeta(newest!);
          if (meta.cwd) this.realPaths.set(p.slug, meta.cwd);
        } catch {
          // leave label as slug
        }
      }
      const nodes = projects.map<ProjectNode>((project) => ({
        kind: 'project',
        project,
        isCurrentWorkspace: wsSlugs.has(project.slug),
      }));
      nodes.sort((a, b) => {
        if (a.isCurrentWorkspace !== b.isCurrentWorkspace) {
          return a.isCurrentWorkspace ? -1 : 1;
        }
        return b.project.latestMtime - a.project.latestMtime;
      });
      return nodes;
    }
    if (element.kind === 'project') {
      const sessions = await listSessions(element.project);
      return sessions.map<SessionNode>((meta) => ({ kind: 'session', meta }));
    }
    return [];
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === 'project') {
      const realPath = this.realPaths.get(element.project.slug);
      const label = realPath ? path.basename(realPath) : element.project.slug;
      const item = new vscode.TreeItem(
        label,
        element.isCurrentWorkspace
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = 'project';
      item.iconPath = new vscode.ThemeIcon('folder');
      item.description = `${element.project.sessionFiles.length} session${
        element.project.sessionFiles.length === 1 ? '' : 's'
      }`;
      item.tooltip = realPath ?? element.project.dir;
      return item;
    }
    const { meta } = element;
    const item = new vscode.TreeItem(meta.title, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'session';
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.description = relativeTime(meta.mtime);
    item.tooltip = new vscode.MarkdownString(
      `**${meta.title}**\n\n${meta.messageCount} messages\n\n\`${meta.sessionId}\``
    );
    return item;
  }
}

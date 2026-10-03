import * as vscode from 'vscode';
import {
  isJsonFile,
  isMarkdownFile,
  isMermaidFile,
  isSameOrDescendant,
  Note,
  NotesManager,
  tableDelimiterOf,
} from './notesManager';

export type ViewMode = 'preview' | 'edit';

/** How the content is rendered in preview mode. */
type RenderKind = 'markdown' | 'table' | 'text' | 'json' | 'mermaid';

/** Messages sent from the extension host to the webview. */
type OutboundMessage =
  | {
      type: 'load';
      content: string;
      mode: ViewMode;
      autoSave: boolean;
      kind: RenderKind;
      delimiter?: string;
    }
  | { type: 'mode'; mode: ViewMode }
  | { type: 'empty' };

/** Messages received from the webview. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'change'; content: string }
  | { type: 'save'; content: string };

/**
 * Drives the "Note" webview view: renders the currently selected note either as
 * rendered markdown (preview) or in a plain-text editor (edit), and keeps the
 * file on disk in sync with edits.
 */
export class NoteViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'activityNote.noteContent';

  private view?: vscode.WebviewView;
  private current?: Note;
  private mode: ViewMode = 'preview';
  private content = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: NotesManager,
  ) {
    this.syncContext();
  }

  /** The note currently shown in the view, if any. */
  get currentNote(): Note | undefined {
    return this.current;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) => this.onMessage(msg));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postState();
      }
    });
    this.updateViewTitle();
  }

  /** Load a note into the view. New notes open straight into edit mode. */
  async showNote(note: Note, mode: ViewMode = 'preview'): Promise<void> {
    this.current = note;
    this.mode = mode;
    try {
      this.content = await this.manager.readNote(note.uri);
    } catch {
      this.content = '';
    }
    this.syncContext();
    this.updateViewTitle();
    this.postState();
    void this.manager.setLastNote(note.uri, mode);
    this.view?.show?.(true);
  }

  /** Switch the view between preview and edit modes. */
  setMode(mode: ViewMode): void {
    if (!this.current) {
      return;
    }
    this.mode = mode;
    this.syncContext();
    this.post({ type: 'mode', mode });
    void this.manager.setLastNote(this.current.uri, mode);
  }

  /** Clear the view (e.g. after the shown note was deleted). */
  clear(): void {
    this.current = undefined;
    this.content = '';
    this.mode = 'preview';
    this.syncContext();
    this.updateViewTitle();
    this.post({ type: 'empty' });
    void this.manager.setLastNote(undefined);
  }

  /**
   * Clear the view if the shown note was removed — either directly or because
   * an ancestor folder was deleted.
   */
  notifyRemoved(uri: vscode.Uri): void {
    if (this.current && isSameOrDescendant(this.current.uri, uri)) {
      this.clear();
    }
  }

  /**
   * Follow the shown note to its new location when it — or an ancestor folder —
   * was renamed or moved.
   */
  async notifyRenamed(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    if (!this.current || !isSameOrDescendant(this.current.uri, oldUri)) {
      return;
    }
    const suffix = this.current.uri.toString().slice(oldUri.toString().length);
    const remappedUri = vscode.Uri.parse(newUri.toString() + suffix);
    await this.showNote(this.manager.noteFromUri(remappedUri), this.mode);
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postState();
        break;
      case 'change':
      case 'save':
        await this.persist(msg.content);
        break;
    }
  }

  private async persist(content: string): Promise<void> {
    if (!this.current) {
      return;
    }
    this.content = content;
    try {
      await this.manager.writeNote(this.current.uri, content);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Activity Note: could not save note. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private postState(): void {
    if (!this.current) {
      this.post({ type: 'empty' });
      return;
    }
    const fileName = this.current.fileName;
    const delimiter = tableDelimiterOf(fileName);
    const kind: RenderKind = isMarkdownFile(fileName)
      ? 'markdown'
      : isJsonFile(fileName)
        ? 'json'
        : isMermaidFile(fileName)
          ? 'mermaid'
          : delimiter
            ? 'table'
            : 'text';
    this.post({
      type: 'load',
      content: this.content,
      mode: this.mode,
      autoSave: this.manager.autoSave,
      kind,
      delimiter,
    });
  }

  private post(message: OutboundMessage): void {
    this.view?.webview.postMessage(message);
  }

  /** Show the current note's file name in the view's title bar. */
  private updateViewTitle(): void {
    if (!this.view) {
      return;
    }
    this.view.title = this.current ? this.current.fileName : undefined;
  }

  private syncContext(): void {
    vscode.commands.executeCommand('setContext', 'activityNote.hasNote', !!this.current);
    vscode.commands.executeCommand('setContext', 'activityNote.mode', this.mode);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer.css'),
    );
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'mermaid.js'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Note</title>
</head>
<body>
  <main class="content">
    <div id="empty" class="empty">
      <p>No note selected.</p>
      <p class="hint">Pick a note from the <strong>Notes</strong> list above, or create one with the <strong>Add Note</strong> button.</p>
    </div>
    <div id="preview" hidden></div>
    <textarea id="editor" class="editor" spellcheck="false" hidden
      placeholder="Start writing…"></textarea>
    <div id="ghost" class="ghost-overlay" aria-hidden="true" hidden></div>
  </main>
  <script nonce="${nonce}">
    window.__activityNote = { mermaidSrc: "${mermaidUri}", nonce: "${nonce}" };
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

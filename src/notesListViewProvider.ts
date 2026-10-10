import * as vscode from 'vscode';
import { buildIconThemeData, IconThemeData, IconThemeSource, loadIconTheme } from './iconTheme';
import { NoteEntry, NotesManager } from './notesManager';

/** A node of the tree as sent to the webview (URIs as strings). */
export interface TreeNodeData {
  kind: 'note' | 'folder';
  /** Label shown in the tree: the file name for notes, the folder name otherwise. */
  name: string;
  uri: string;
  children?: TreeNodeData[];
}

/** Why the tree is empty, so the webview can show the matching welcome content. */
type EmptyReason = 'noFolder' | 'empty';

/** Messages sent from the extension host to the webview. */
type OutboundMessage =
  | {
      type: 'tree';
      rootUri?: string;
      nodes: TreeNodeData[];
      empty?: EmptyReason;
      /** Start inline editing of this node once rendered. */
      edit?: string;
    }
  | { type: 'reveal'; uri: string }
  | { type: 'edit'; uri: string }
  | { type: 'renameResult'; uri: string; ok: true; newUri: string }
  | { type: 'renameResult'; uri: string; ok: false; error: string }
  | { type: 'moved'; oldUri: string; newUri: string }
  | { type: 'collapseAll' }
  | { type: 'iconTheme'; data?: IconThemeData };

/** Messages received from the webview. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'select'; uri?: string; kind?: 'note' | 'folder' }
  | { type: 'open'; uri: string }
  | { type: 'rename'; uri: string; kind: 'note' | 'folder'; name: string }
  | { type: 'cancelEdit'; uri: string }
  | { type: 'move'; uri: string; kind: 'note' | 'folder'; targetDir: string }
  | { type: 'command'; command: string; uri?: string; kind?: 'note' | 'folder' | 'root' }
  | { type: 'focus'; focused: boolean }
  | { type: 'editing'; editing: boolean }
  | { type: 'error'; message: string };

/**
 * Callbacks into the extension for the actions the tree triggers but does not
 * own itself (opening a note, following renames in the Note view, …).
 */
export interface NotesListHost {
  openNote(uri: vscode.Uri): Promise<void>;
  renamed(oldEntry: NoteEntry, newEntry: NoteEntry): Promise<void>;
  /** An inline edit of a freshly created note ended (committed or cancelled). */
  createdNoteNamed(uri: vscode.Uri): Promise<void>;
}

/**
 * Drives the "Notes" webview view: a file tree drawn by the webview itself so
 * that names can be edited inline (which the native TreeView API cannot do),
 * with keyboard navigation and drag & drop to move entries.
 */
export class NotesListViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'activityNote.notesList';

  private view?: vscode.WebviewView;
  private ready = false;
  private generation = 0;
  private title = 'Notes';
  private description?: string;
  /** Node to put in edit mode as soon as it shows up in the tree. */
  private pendingEdit?: string;
  /** Node to reveal once the webview is ready. */
  private pendingReveal?: string;
  /** A note created by "Add Note" that is waiting for its inline name. */
  private freshNote?: string;
  private selected?: { uri: vscode.Uri; kind: 'note' | 'folder' };
  /** The active file icon theme, so the tree shows the same icons as the Explorer. */
  private iconTheme?: IconThemeSource;
  private iconThemeLoaded: Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: NotesManager,
    private readonly host: NotesListHost,
  ) {
    this.setContext('activityNote.notesListFocus', false);
    this.setContext('activityNote.notesListEditing', false);
    this.iconThemeLoaded = this.reloadIconTheme();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('workbench.iconTheme')) {
          this.iconThemeLoaded = this.reloadIconTheme();
        }
      }),
      vscode.extensions.onDidChange(() => {
        this.iconThemeLoaded = this.reloadIconTheme();
      }),
      // Icon themes may have light / high-contrast variants.
      vscode.window.onDidChangeActiveColorTheme(() => this.postIconTheme()),
    );
  }

  /** The entry selected in the tree, if any. */
  get selection(): NoteEntry | undefined {
    if (!this.selected) {
      return undefined;
    }
    return this.selected.kind === 'note'
      ? this.manager.noteFromUri(this.selected.uri)
      : this.manager.folderFromUri(this.selected.uri);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.loadHtml();
    this.applyTitle();
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((msg: InboundMessage) => this.onMessage(msg)),
      webviewView.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
        this.setContext('activityNote.notesListFocus', false);
        this.setContext('activityNote.notesListEditing', false);
      }),
    );
  }

  /** (Re)load the webview; its resource roots include the icon theme's extension. */
  private loadHtml(): void {
    if (!this.view) {
      return;
    }
    this.ready = false;
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'media')];
    if (this.iconTheme) {
      roots.push(this.iconTheme.extensionUri);
    }
    this.view.webview.options = { enableScripts: true, localResourceRoots: roots };
    this.view.webview.html = this.getHtml(this.view.webview);
  }

  private async reloadIconTheme(): Promise<void> {
    const previousRoot = this.iconTheme?.extensionUri.toString();
    this.iconTheme = await loadIconTheme();
    if (this.iconTheme?.extensionUri.toString() !== previousRoot) {
      // A different extension's files must be allowed first, which needs a reload.
      this.loadHtml();
    } else {
      this.postIconTheme();
    }
  }

  private postIconTheme(): void {
    if (this.view && this.ready) {
      this.post({
        type: 'iconTheme',
        data: this.iconTheme ? buildIconThemeData(this.iconTheme, this.view.webview) : undefined,
      });
    }
  }

  /** Update the view's title bar ("name" plus "(path)" as its description). */
  setTitle(title: string, description?: string): void {
    this.title = title;
    this.description = description;
    this.applyTitle();
  }

  /** Re-read the notes folder and send the whole tree to the webview. */
  refresh(): void {
    void this.postTree();
  }

  /** Select a node (expanding its ancestors) and scroll it into view. */
  reveal(uri: vscode.Uri): void {
    if (this.ready) {
      this.post({ type: 'reveal', uri: uri.toString() });
    } else {
      this.pendingReveal = uri.toString();
    }
  }

  /** Put a node's name into inline edit mode. */
  async startEdit(uri: vscode.Uri): Promise<void> {
    await this.show();
    if (this.ready) {
      this.post({ type: 'edit', uri: uri.toString() });
    } else {
      this.pendingEdit = uri.toString();
    }
  }

  /**
   * Show a just-created entry in edit mode. For notes, the host is told once
   * the name is settled, so the note opens under its final name.
   */
  async editCreated(entry: NoteEntry): Promise<void> {
    if (entry.kind === 'note') {
      this.freshNote = entry.uri.toString();
    }
    this.pendingEdit = entry.uri.toString();
    await this.show();
    await this.postTree();
  }

  collapseAll(): void {
    this.post({ type: 'collapseAll' });
  }

  /** Bring the view on screen (it may not even be resolved yet). */
  private async show(): Promise<void> {
    if (this.view) {
      this.view.show(false);
      return;
    }
    await vscode.commands.executeCommand(`${NotesListViewProvider.viewType}.focus`);
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        await this.iconThemeLoaded;
        this.postIconTheme();
        await this.postTree();
        if (this.pendingReveal) {
          this.post({ type: 'reveal', uri: this.pendingReveal });
          this.pendingReveal = undefined;
        }
        break;
      case 'select':
        this.selected =
          msg.uri && msg.kind ? { uri: vscode.Uri.parse(msg.uri), kind: msg.kind } : undefined;
        break;
      case 'open':
        await this.host.openNote(vscode.Uri.parse(msg.uri));
        break;
      case 'rename':
        await this.rename(msg.uri, msg.kind, msg.name);
        break;
      case 'cancelEdit':
        await this.settleFreshNote(msg.uri, vscode.Uri.parse(msg.uri));
        break;
      case 'move':
        await this.move(msg.uri, msg.kind, msg.targetDir);
        break;
      case 'command':
        await vscode.commands.executeCommand(msg.command, msg.uri ? { uri: msg.uri, kind: msg.kind } : undefined);
        break;
      case 'focus':
        this.setContext('activityNote.notesListFocus', msg.focused);
        break;
      case 'editing':
        this.setContext('activityNote.notesListEditing', msg.editing);
        break;
      case 'error':
        vscode.window.showErrorMessage(`Activity Note: ${msg.message}`);
        break;
    }
  }

  private async rename(uri: string, kind: 'note' | 'folder', name: string): Promise<void> {
    const entry = this.entryFrom(uri, kind);
    try {
      const renamed = await this.manager.rename(entry, name);
      this.post({ type: 'renameResult', uri, ok: true, newUri: renamed.uri.toString() });
      await this.host.renamed(entry, renamed);
      await this.settleFreshNote(uri, renamed.uri);
    } catch (err) {
      this.post({ type: 'renameResult', uri, ok: false, error: errorText(err) });
    }
  }

  private async move(uri: string, kind: 'note' | 'folder', targetDir: string): Promise<void> {
    const entry = this.entryFrom(uri, kind);
    try {
      const moved = await this.manager.move(entry, vscode.Uri.parse(targetDir));
      if (moved.uri.toString() !== uri) {
        this.post({ type: 'moved', oldUri: uri, newUri: moved.uri.toString() });
        await this.host.renamed(entry, moved);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Activity Note: ${errorText(err)}`);
    }
  }

  /** Open a freshly created note once its name has been settled. */
  private async settleFreshNote(uri: string, finalUri: vscode.Uri): Promise<void> {
    if (this.freshNote !== uri) {
      return;
    }
    this.freshNote = undefined;
    await this.host.createdNoteNamed(finalUri);
  }

  private entryFrom(uri: string, kind: 'note' | 'folder'): NoteEntry {
    const parsed = vscode.Uri.parse(uri);
    return kind === 'note' ? this.manager.noteFromUri(parsed) : this.manager.folderFromUri(parsed);
  }

  private async postTree(): Promise<void> {
    if (!this.view || !this.ready) {
      return;
    }
    // Several refreshes can overlap; only the most recent one gets posted.
    const generation = ++this.generation;
    const root = this.manager.getFolder();
    const nodes = root ? await this.readTree(root) : [];
    if (generation !== this.generation) {
      return;
    }
    let edit: string | undefined;
    if (this.pendingEdit && containsUri(nodes, this.pendingEdit)) {
      edit = this.pendingEdit;
      this.pendingEdit = undefined;
    }
    this.post({
      type: 'tree',
      rootUri: root?.toString(),
      nodes,
      empty: !root ? 'noFolder' : nodes.length === 0 ? 'empty' : undefined,
      edit,
    });
  }

  private async readTree(dir: vscode.Uri): Promise<TreeNodeData[]> {
    const entries = await this.manager.listChildren(dir);
    return Promise.all(
      entries.map(async (entry): Promise<TreeNodeData> =>
        entry.kind === 'folder'
          ? {
              kind: 'folder',
              name: entry.label,
              uri: entry.uri.toString(),
              children: await this.readTree(entry.uri),
            }
          : { kind: 'note', name: entry.fileName, uri: entry.uri.toString() },
      ),
    );
  }

  private applyTitle(): void {
    if (this.view) {
      this.view.title = this.title;
      this.view.description = this.description;
    }
  }

  private post(message: OutboundMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private setContext(key: string, value: boolean): void {
    void vscode.commands.executeCommand('setContext', key, value);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'tree.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'tree.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.css'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
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
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <style id="icon-theme"></style>
  <title>Notes</title>
</head>
<body>
  <div id="tree" class="tree" tabindex="0"
    data-vscode-context='{"webviewSection":"root","preventDefaultContextMenuItems":true}'>
    <div id="rows" role="tree" aria-label="Notes"></div>
    <div id="welcome" class="welcome" hidden></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function containsUri(nodes: TreeNodeData[], uri: string): boolean {
  return nodes.some((node) => node.uri === uri || (node.children ? containsUri(node.children, uri) : false));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

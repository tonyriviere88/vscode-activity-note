import * as vscode from 'vscode';
import { baseName, Note, NoteEntry, NoteFolder, NotesManager, parentOf } from './notesManager';

/** A tree item wrapping a single note (a leaf). */
export class NoteTreeItem extends vscode.TreeItem {
  constructor(public readonly note: Note) {
    // Show the full file name (with extension) as the label, like the Explorer.
    super(note.fileName, vscode.TreeItemCollapsibleState.None);
    // A stable id lets TreeView.reveal() match a freshly-built item.
    this.id = note.uri.toString();
    // resourceUri drives the file-type icon from the active icon theme.
    this.resourceUri = note.uri;
    this.tooltip = note.uri.fsPath;
    this.contextValue = 'note';
    // Clicking a note loads it into the content view.
    this.command = {
      command: 'activityNote.openNote',
      title: 'Open Note',
      arguments: [note],
    };
  }
}

/** A tree item wrapping a sub-folder (expandable). */
export class FolderTreeItem extends vscode.TreeItem {
  constructor(public readonly folder: NoteFolder) {
    super(folder.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = folder.uri.toString();
    this.resourceUri = folder.uri;
    this.tooltip = folder.uri.fsPath;
    this.contextValue = 'folder';
  }
}

export type NoteTreeNode = NoteTreeItem | FolderTreeItem;

/** Provides the hierarchical list of folders and notes for the "Notes" view. */
export class NotesTreeProvider implements vscode.TreeDataProvider<NoteTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: NotesManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: NoteTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NoteTreeNode): Promise<NoteTreeNode[]> {
    if (element instanceof NoteTreeItem) {
      return [];
    }
    const dir = element instanceof FolderTreeItem ? element.folder.uri : this.manager.getFolder();
    if (!dir) {
      return [];
    }
    const entries = await this.manager.listChildren(dir);
    return entries.map((entry) => toNode(entry));
  }

  /** Required for TreeView.reveal(); walks up to (but not including) the root. */
  getParent(element: NoteTreeNode): vscode.ProviderResult<NoteTreeNode> {
    const root = this.manager.getFolder();
    if (!root) {
      return undefined;
    }
    const uri = element instanceof FolderTreeItem ? element.folder.uri : element.note.uri;
    const parent = parentOf(uri);
    if (parent.toString() === root.toString() || parent.toString() === uri.toString()) {
      return undefined;
    }
    return new FolderTreeItem({ kind: 'folder', label: baseName(parent), uri: parent });
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

function toNode(entry: NoteEntry): NoteTreeNode {
  return entry.kind === 'folder' ? new FolderTreeItem(entry) : new NoteTreeItem(entry);
}

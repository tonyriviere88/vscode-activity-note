import * as vscode from 'vscode';
import {
  baseName,
  extensionOf,
  isSameOrDescendant,
  Note,
  NoteEntry,
  NotesManager,
  parentOf,
} from './notesManager';
import { FolderTreeItem, NoteTreeItem, NoteTreeNode, NotesTreeProvider } from './notesTreeProvider';
import { NoteViewProvider } from './noteViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const manager = new NotesManager(context);
  const treeProvider = new NotesTreeProvider(manager);
  const viewProvider = new NoteViewProvider(context.extensionUri, manager);

  const treeView = vscode.window.createTreeView<NoteTreeNode>('activityNote.notesList', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const updateTitle = (): void => {
    const folder = manager.getFolder();
    if (folder) {
      // Show the folder as "name (path)" in the view's title bar.
      treeView.title = baseName(folder);
      treeView.description = `(${folder.fsPath})`;
      treeView.message = undefined;
    } else {
      treeView.title = 'Notes';
      treeView.description = undefined;
      treeView.message = 'No notes folder selected. Use the folder button to choose one.';
    }
  };
  updateTitle();

  context.subscriptions.push(
    manager,
    treeProvider,
    treeView,
    vscode.window.registerWebviewViewProvider(NoteViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    manager.onDidChangeNotes(() => {
      treeProvider.refresh();
      updateTitle();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('activityNote')) {
        treeProvider.refresh();
        updateTitle();
      }
    }),
  );

  const openNote = async (note: Note, mode: 'preview' | 'edit' = 'preview'): Promise<void> => {
    await viewProvider.showNote(note, mode);
    // Keep the tree selection in sync when a note is opened programmatically.
    try {
      await treeView.reveal(new NoteTreeItem(note), { select: true, focus: false, expand: true });
    } catch {
      /* reveal can throw if the item is not (yet) in the tree; ignore. */
    }
  };

  /** Resolve the note/folder a command should act on. */
  const resolveTarget = (arg?: NoteTreeNode): NoteEntry | undefined => {
    if (arg instanceof FolderTreeItem) {
      return arg.folder;
    }
    if (arg instanceof NoteTreeItem) {
      return arg.note;
    }
    const selected = treeView.selection[0];
    if (selected instanceof FolderTreeItem) {
      return selected.folder;
    }
    if (selected instanceof NoteTreeItem) {
      return selected.note;
    }
    return viewProvider.currentNote;
  };

  /** Decide which directory a new note/folder should be created in. */
  const resolveParentDir = (arg?: NoteTreeNode): vscode.Uri | undefined => {
    const root = manager.getFolder();
    if (!root) {
      return undefined;
    }
    const target = resolveTarget(arg);
    if (target?.kind === 'folder') {
      return target.uri;
    }
    if (target?.kind === 'note') {
      return parentOf(target.uri);
    }
    return root;
  };

  const ensureFolder = async (): Promise<boolean> => {
    if (manager.getFolder()) {
      return true;
    }
    const choice = await vscode.window.showInformationMessage(
      'Choose a folder to store your notes first.',
      'Choose Folder',
    );
    return choice === 'Choose Folder' ? selectFolder() : false;
  };

  const selectFolder = async (): Promise<boolean> => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use as Notes Folder',
      title: 'Select the folder where Activity Note stores your notes',
      defaultUri: manager.getFolder(),
    });
    if (!picked || picked.length === 0) {
      return false;
    }
    await manager.setFolder(picked[0]);
    return true;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('activityNote.openNote', (note: Note) => openNote(note)),

    vscode.commands.registerCommand('activityNote.selectFolder', () => selectFolder()),

    vscode.commands.registerCommand('activityNote.refresh', () => treeProvider.refresh()),

    vscode.commands.registerCommand('activityNote.addNote', async (arg?: NoteTreeNode) => {
      if (!(await ensureFolder())) {
        return;
      }
      const parentDir = resolveParentDir(arg);
      if (!parentDir) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Name of the new note',
        placeHolder: 'My note',
        validateInput: (value) => (value.trim().length === 0 ? 'Please enter a name.' : undefined),
      });
      if (!name) {
        return;
      }
      try {
        const note = await manager.createNote(name, parentDir);
        await openNote(note, 'edit');
      } catch (err) {
        vscode.window.showErrorMessage(errorMessage(err));
      }
    }),

    vscode.commands.registerCommand('activityNote.newFolder', async (arg?: NoteTreeNode) => {
      if (!(await ensureFolder())) {
        return;
      }
      const parentDir = resolveParentDir(arg);
      if (!parentDir) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Name of the new folder',
        placeHolder: 'My folder',
        validateInput: (value) => (value.trim().length === 0 ? 'Please enter a name.' : undefined),
      });
      if (!name) {
        return;
      }
      try {
        const folder = await manager.createFolder(name, parentDir);
        await treeView.reveal(new FolderTreeItem(folder), { select: true, expand: true });
      } catch (err) {
        vscode.window.showErrorMessage(errorMessage(err));
      }
    }),

    vscode.commands.registerCommand('activityNote.renameNote', async (arg?: NoteTreeNode) => {
      const target = resolveTarget(arg);
      if (!target) {
        vscode.window.showInformationMessage('Nothing selected to rename.');
        return;
      }
      // Show the full file name (with extension) for notes; pre-select the base
      // name so the extension is kept unless the user deliberately changes it.
      const currentName = target.kind === 'note' ? target.fileName : target.label;
      const ext = target.kind === 'note' ? extensionOf(currentName) : '';
      const baseEnd = ext ? currentName.length - ext.length - 1 : currentName.length;
      const name = await vscode.window.showInputBox({
        prompt: `New name for the ${target.kind}`,
        value: currentName,
        valueSelection: [0, Math.max(baseEnd, 0)],
        validateInput: (value) => (value.trim().length === 0 ? 'Please enter a name.' : undefined),
      });
      if (!name || name.trim() === currentName) {
        return;
      }
      try {
        const renamed = await manager.rename(target, name);
        await viewProvider.notifyRenamed(target.uri, renamed.uri);
        if (renamed.kind === 'note') {
          await openNote(renamed, 'preview');
        }
      } catch (err) {
        vscode.window.showErrorMessage(errorMessage(err));
      }
    }),

    vscode.commands.registerCommand('activityNote.deleteNote', async (arg?: NoteTreeNode) => {
      const target = resolveTarget(arg);
      if (!target) {
        vscode.window.showInformationMessage('Nothing selected to delete.');
        return;
      }
      const detail =
        target.kind === 'folder'
          ? 'The folder and all notes inside it will be moved to your system trash.'
          : 'The file will be moved to your system trash.';
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${target.kind} "${target.label}"?`,
        { modal: true, detail },
        'Delete',
      );
      if (confirm !== 'Delete') {
        return;
      }
      try {
        await manager.delete(target);
        viewProvider.notifyRemoved(target.uri);
      } catch (err) {
        vscode.window.showErrorMessage(errorMessage(err));
      }
    }),

    vscode.commands.registerCommand('activityNote.revealInExplorer', async (arg?: NoteTreeNode) => {
      const target = resolveTarget(arg);
      if (target) {
        await vscode.commands.executeCommand('revealFileInOS', target.uri);
      }
    }),

    vscode.commands.registerCommand('activityNote.openInEditor', async (arg?: NoteTreeNode) => {
      const target = resolveTarget(arg);
      if (target?.kind === 'note') {
        // vscode.open uses the default/registered editor for the file type,
        // so installed viewers (CSV tables, image preview, …) are reused.
        await vscode.commands.executeCommand('vscode.open', target.uri);
      }
    }),

    vscode.commands.registerCommand('activityNote.editMode', () => viewProvider.setMode('edit')),
    vscode.commands.registerCommand('activityNote.previewMode', () =>
      viewProvider.setMode('preview'),
    ),
  );

  // Reopen the note that was open when the extension was last shut down.
  void restoreLastNote();

  async function restoreLastNote(): Promise<void> {
    const last = manager.getLastNote();
    const folder = manager.getFolder();
    if (!last || !folder || !isSameOrDescendant(last.uri, folder)) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(last.uri);
      if (stat.type !== vscode.FileType.File) {
        throw new Error('not a file');
      }
    } catch {
      // The note was moved or deleted while the extension was inactive.
      await manager.setLastNote(undefined);
      return;
    }
    await openNote(manager.noteFromUri(last.uri), last.mode);
  }
}

export function deactivate(): void {
  /* Nothing to clean up beyond the disposables registered in activate(). */
}

function errorMessage(err: unknown): string {
  return `Activity Note: ${err instanceof Error ? err.message : String(err)}`;
}

import * as vscode from 'vscode';
import { baseName, isSameOrDescendant, Note, NoteEntry, NotesManager, parentOf } from './notesManager';
import { NotesListViewProvider } from './notesListViewProvider';
import { NoteViewProvider } from './noteViewProvider';

/**
 * What a command receives when run from the Notes view: the right-clicked
 * entry's webview context (or an inline row button), or nothing when run from
 * a title bar button or a keybinding.
 */
interface CommandArg {
  uri?: string;
  kind?: 'note' | 'folder' | 'root';
}

export function activate(context: vscode.ExtensionContext): void {
  const manager = new NotesManager(context);
  const viewProvider = new NoteViewProvider(context.extensionUri, manager);

  const openNote = async (note: Note, mode: 'preview' | 'edit' = 'preview'): Promise<void> => {
    await viewProvider.showNote(note, mode);
    // Keep the tree selection in sync when a note is opened programmatically.
    listProvider.reveal(note.uri);
  };

  const listProvider = new NotesListViewProvider(context.extensionUri, manager, {
    openNote: (uri) => openNote(manager.noteFromUri(uri)),
    renamed: (oldEntry, newEntry) => viewProvider.notifyRenamed(oldEntry.uri, newEntry.uri),
    // A new note opens for writing once its name has been settled inline.
    createdNoteNamed: (uri) => openNote(manager.noteFromUri(uri), 'edit'),
  });

  const updateTitle = (): void => {
    const folder = manager.getFolder();
    // Show the folder as "name (path)" in the view's title bar.
    listProvider.setTitle(folder ? baseName(folder) : 'Notes', folder ? `(${folder.fsPath})` : undefined);
  };
  updateTitle();

  context.subscriptions.push(
    manager,
    listProvider,
    vscode.window.registerWebviewViewProvider(NotesListViewProvider.viewType, listProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(NoteViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    manager.onDidChangeNotes(() => {
      listProvider.refresh();
      updateTitle();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('activityNote')) {
        listProvider.refresh();
        updateTitle();
      }
    }),
  );

  /** Resolve the note/folder a command should act on. */
  const resolveTarget = (arg?: CommandArg): NoteEntry | undefined => {
    if (arg?.uri && arg.kind === 'note') {
      return manager.noteFromUri(vscode.Uri.parse(arg.uri));
    }
    if (arg?.uri && arg.kind === 'folder') {
      return manager.folderFromUri(vscode.Uri.parse(arg.uri));
    }
    return listProvider.selection ?? viewProvider.currentNote;
  };

  /** Decide which directory a new note/folder should be created in. */
  const resolveParentDir = (arg?: CommandArg): vscode.Uri | undefined => {
    const root = manager.getFolder();
    if (!root) {
      return undefined;
    }
    if (arg?.kind === 'root') {
      // Right-click on the empty space below the entries.
      return root;
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
    vscode.commands.registerCommand('activityNote.selectFolder', () => selectFolder()),

    vscode.commands.registerCommand('activityNote.refresh', () => listProvider.refresh()),

    vscode.commands.registerCommand('activityNote.collapseAll', () => listProvider.collapseAll()),

    // New notes and folders are created right away under a default name, which
    // is then put into inline edit mode in the tree.
    vscode.commands.registerCommand('activityNote.addNote', async (arg?: CommandArg) => {
      if (!(await ensureFolder())) {
        return;
      }
      const parentDir = resolveParentDir(arg);
      if (!parentDir) {
        return;
      }
      try {
        await listProvider.editCreated(await manager.createUntitledNote(parentDir));
      } catch (err) {
        vscode.window.showErrorMessage(errorMessage(err));
      }
    }),

    vscode.commands.registerCommand('activityNote.newFolder', async (arg?: CommandArg) => {
      if (!(await ensureFolder())) {
        return;
      }
      const parentDir = resolveParentDir(arg);
      if (!parentDir) {
        return;
      }
      try {
        await listProvider.editCreated(await manager.createUntitledFolder(parentDir));
      } catch (err) {
        vscode.window.showErrorMessage(errorMessage(err));
      }
    }),

    vscode.commands.registerCommand('activityNote.renameNote', async (arg?: CommandArg) => {
      const target = resolveTarget(arg);
      if (!target) {
        vscode.window.showInformationMessage('Nothing selected to rename.');
        return;
      }
      await listProvider.startEdit(target.uri);
    }),

    vscode.commands.registerCommand('activityNote.deleteNote', async (arg?: CommandArg) => {
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

    vscode.commands.registerCommand('activityNote.revealInExplorer', async (arg?: CommandArg) => {
      const target = resolveTarget(arg);
      if (target) {
        await vscode.commands.executeCommand('revealFileInOS', target.uri);
      }
    }),

    vscode.commands.registerCommand('activityNote.openInEditor', async (arg?: CommandArg) => {
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

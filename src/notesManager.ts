import * as vscode from 'vscode';

/** A markdown note file on disk. */
export interface Note {
  readonly kind: 'note';
  /** Display name, i.e. the file name without its `.md` extension. */
  readonly label: string;
  /** The file name on disk, including the `.md` extension. */
  readonly fileName: string;
  /** Absolute location of the note file. */
  readonly uri: vscode.Uri;
}

/** A sub-folder inside the notes tree. */
export interface NoteFolder {
  readonly kind: 'folder';
  /** Display name (the folder's own name). */
  readonly label: string;
  /** Absolute location of the folder. */
  readonly uri: vscode.Uri;
}

/** Anything that can appear in the notes tree. */
export type NoteEntry = Note | NoteFolder;

/** How a note is displayed in the content view. */
export type NoteMode = 'preview' | 'edit';

const FOLDER_STATE_KEY = 'activityNote.notesFolder';
const LAST_NOTE_KEY = 'activityNote.lastNoteUri';
const LAST_MODE_KEY = 'activityNote.lastNoteMode';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Extensions that are rendered as markdown in preview mode. */
const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx'];

/** Fallback list, kept in sync with the `activityNote.fileExtensions` default. */
const DEFAULT_EXTENSIONS = [
  'md', 'markdown', 'mdx', 'txt', 'text', 'todo', 'log', 'rst', 'org',
  'csv', 'tsv', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'mmd', 'mermaid',
];

/** The lower-cased extension of a file name, without the dot (`''` if none). */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/** Whether a file should be rendered as markdown rather than plain text. */
export function isMarkdownFile(fileName: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(extensionOf(fileName));
}

/** Whether a file should be rendered as an interactive JSON tree. */
export function isJsonFile(fileName: string): boolean {
  const ext = extensionOf(fileName);
  return ext === 'json' || ext === 'jsonc';
}

/** Whether a file is a standalone Mermaid diagram. */
export function isMermaidFile(fileName: string): boolean {
  const ext = extensionOf(fileName);
  return ext === 'mmd' || ext === 'mermaid';
}

/**
 * The default column delimiter used to render a file as a table, or `undefined`
 * when the file isn't tabular. `.csv` may still be re-sniffed (comma/semicolon)
 * by the viewer; `.tsv` is always tab-separated.
 */
export function tableDelimiterOf(fileName: string): string | undefined {
  const ext = extensionOf(fileName);
  if (ext === 'csv') {
    return ',';
  }
  if (ext === 'tsv') {
    return '\t';
  }
  return undefined;
}

/** The last path segment of a URI (its file/folder name). */
export function baseName(uri: vscode.Uri): string {
  const parts = uri.path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : uri.fsPath;
}

/** The parent directory of a URI. */
export function parentOf(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

/** Whether `candidate` is `ancestor` itself or lives somewhere beneath it. */
export function isSameOrDescendant(candidate: vscode.Uri, ancestor: vscode.Uri): boolean {
  const a = candidate.toString();
  const b = ancestor.toString();
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

/**
 * Owns everything related to note storage: which folder is used, listing,
 * creating, reading, writing, renaming and deleting notes and sub-folders. It
 * is intentionally UI-agnostic so it can be driven by both views.
 */
export class NotesManager {
  private readonly _onDidChangeNotes = new vscode.EventEmitter<void>();
  /** Fires whenever the set of notes (or the notes folder) changes. */
  readonly onDidChangeNotes = this._onDidChangeNotes.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Resolve the active (root) notes folder, or `undefined` when none is set. */
  getFolder(): vscode.Uri | undefined {
    const configured = vscode.workspace
      .getConfiguration('activityNote')
      .get<string>('notesFolder', '')
      .trim();
    if (configured) {
      return vscode.Uri.file(configured);
    }
    const stored = this.context.globalState.get<string>(FOLDER_STATE_KEY, '');
    return stored ? vscode.Uri.file(stored) : undefined;
  }

  /** Persist the chosen root notes folder and notify listeners. */
  async setFolder(uri: vscode.Uri): Promise<void> {
    await this.context.globalState.update(FOLDER_STATE_KEY, uri.fsPath);
    this._onDidChangeNotes.fire();
  }

  /** Whether edits should be flushed to disk automatically while typing. */
  get autoSave(): boolean {
    return vscode.workspace.getConfiguration('activityNote').get<boolean>('autoSave', true);
  }

  /** The note (and mode) that was open last, to restore on the next launch. */
  getLastNote(): { uri: vscode.Uri; mode: NoteMode } | undefined {
    const stored = this.context.globalState.get<string>(LAST_NOTE_KEY, '');
    if (!stored) {
      return undefined;
    }
    const mode = this.context.globalState.get<NoteMode>(LAST_MODE_KEY, 'preview');
    return { uri: vscode.Uri.parse(stored), mode: mode === 'edit' ? 'edit' : 'preview' };
  }

  /** Remember which note (and mode) is open so it can be restored later. */
  async setLastNote(uri: vscode.Uri | undefined, mode: NoteMode = 'preview'): Promise<void> {
    await this.context.globalState.update(LAST_NOTE_KEY, uri ? uri.toString() : undefined);
    await this.context.globalState.update(LAST_MODE_KEY, uri ? mode : undefined);
  }

  /** The file extensions (without dots) that should appear in the tree. */
  getSupportedExtensions(): string[] {
    const configured = vscode.workspace
      .getConfiguration('activityNote')
      .get<string[]>('fileExtensions', DEFAULT_EXTENSIONS);
    return configured
      .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
      .filter((ext) => ext.length > 0);
  }

  private get defaultExtension(): string {
    const configured = vscode.workspace
      .getConfiguration('activityNote')
      .get<string>('defaultExtension', 'md')
      .trim()
      .replace(/^\./, '')
      .toLowerCase();
    return configured || 'md';
  }

  private isSupported(fileName: string): boolean {
    return this.getSupportedExtensions().includes(extensionOf(fileName));
  }

  /**
   * List the direct children of a directory: sub-folders first, then markdown
   * notes, each group sorted by name. Hidden folders (dot-folders) are skipped.
   */
  async listChildren(dir: vscode.Uri): Promise<NoteEntry[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }

    const byName = (a: NoteEntry, b: NoteEntry): number =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });

    const folders = entries
      .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.'))
      .map(([name]) => this.toFolder(vscode.Uri.joinPath(dir, name)))
      .sort(byName);

    const notes = entries
      .filter(([name, type]) => type === vscode.FileType.File && this.isSupported(name))
      .map(([name]) => this.toNote(dir, name))
      .sort(byName);

    return [...folders, ...notes];
  }

  /** Create a new empty note inside `parentDir`. Throws if it already exists. */
  async createNote(rawName: string, parentDir: vscode.Uri): Promise<Note> {
    const base = this.sanitizeName(rawName);
    // Keep an extension the user typed (if it's supported), otherwise add the default one.
    const fileName = this.isSupported(base) ? base : `${base}.${this.defaultExtension}`;
    const uri = vscode.Uri.joinPath(parentDir, fileName);
    if (await this.exists(uri)) {
      throw new Error(`A note named "${fileName}" already exists here.`);
    }
    await vscode.workspace.fs.createDirectory(parentDir);
    // Only seed markdown notes with a heading; other text files start empty.
    const seed = isMarkdownFile(fileName) ? `# ${this.stripExtension(fileName)}\n\n` : '';
    await vscode.workspace.fs.writeFile(uri, encoder.encode(seed));
    this._onDidChangeNotes.fire();
    return this.toNote(parentDir, fileName);
  }

  /** Create a new sub-folder inside `parentDir`. Throws if it already exists. */
  async createFolder(rawName: string, parentDir: vscode.Uri): Promise<NoteFolder> {
    const name = this.sanitizeName(rawName);
    const uri = vscode.Uri.joinPath(parentDir, name);
    if (await this.exists(uri)) {
      throw new Error(`A folder named "${name}" already exists here.`);
    }
    await vscode.workspace.fs.createDirectory(uri);
    this._onDidChangeNotes.fire();
    return this.toFolder(uri);
  }

  /** Rename a note or folder in place. Returns the renamed entry. */
  async rename(entry: NoteEntry, rawName: string): Promise<NoteEntry> {
    const parent = parentOf(entry.uri);
    const newName = entry.kind === 'note' ? this.renamedFileName(entry, rawName) : this.sanitizeName(rawName);
    if (newName === baseName(entry.uri)) {
      return entry;
    }
    const target = vscode.Uri.joinPath(parent, newName);
    if (await this.exists(target)) {
      throw new Error(`A ${entry.kind} named "${newName}" already exists here.`);
    }
    await vscode.workspace.fs.rename(entry.uri, target, { overwrite: false });
    this._onDidChangeNotes.fire();
    return entry.kind === 'note' ? this.toNote(parent, newName) : this.toFolder(target);
  }

  /** Delete a note, or a folder together with everything inside it. */
  async delete(entry: NoteEntry): Promise<void> {
    await vscode.workspace.fs.delete(entry.uri, {
      recursive: entry.kind === 'folder',
      useTrash: true,
    });
    this._onDidChangeNotes.fire();
  }

  /** Read a note's markdown source. */
  async readNote(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    return decoder.decode(data);
  }

  /** Write a note's markdown source to disk. */
  async writeNote(uri: vscode.Uri, content: string): Promise<void> {
    await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
  }

  /** Build a `Note` descriptor from a note file URI. */
  noteFromUri(uri: vscode.Uri): Note {
    return this.toNote(parentOf(uri), baseName(uri));
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private toFolder(uri: vscode.Uri): NoteFolder {
    return { kind: 'folder', label: baseName(uri), uri };
  }

  private toNote(dir: vscode.Uri, fileName: string): Note {
    return {
      kind: 'note',
      label: this.stripExtension(fileName),
      fileName,
      uri: vscode.Uri.joinPath(dir, fileName),
    };
  }

  private stripExtension(fileName: string): string {
    const ext = extensionOf(fileName);
    return ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
  }

  /** Build the new file name for a renamed note, preserving its extension. */
  private renamedFileName(note: Note, rawName: string): string {
    const base = this.sanitizeName(rawName);
    // If the user typed a supported extension, honour it; otherwise keep the current one.
    return this.isSupported(base) ? base : `${base}.${extensionOf(note.fileName) || this.defaultExtension}`;
  }

  /** Strip characters that are illegal in file/folder names on common platforms. */
  private sanitizeName(rawName: string): string {
    const name = rawName
      .trim()
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/[ .]+$/, '') // Windows disallows trailing dots/spaces.
      .trim();
    if (!name) {
      throw new Error('Please provide a valid name.');
    }
    return name;
  }

  dispose(): void {
    this._onDidChangeNotes.dispose();
  }
}

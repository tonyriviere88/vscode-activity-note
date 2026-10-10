interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type EntryKind = 'note' | 'folder';

interface TreeNode {
  kind: EntryKind;
  name: string;
  uri: string;
  children?: TreeNode[];
}

type InboundMessage =
  | { type: 'tree'; rootUri?: string; nodes: TreeNode[]; empty?: 'noFolder' | 'empty'; edit?: string }
  | { type: 'reveal'; uri: string }
  | { type: 'edit'; uri: string }
  | { type: 'renameResult'; uri: string; ok: true; newUri: string }
  | { type: 'renameResult'; uri: string; ok: false; error: string }
  | { type: 'moved'; oldUri: string; newUri: string }
  | { type: 'collapseAll' }
  | { type: 'iconTheme'; data?: IconTheme };

/** A visible line of the tree. */
interface Row {
  node: TreeNode;
  depth: number;
}

interface SavedState {
  expanded: string[];
  selected?: string;
}

/** The inline name editor currently open, if any. */
interface EditState {
  uri: string;
  kind: EntryKind;
  original: string;
  input: HTMLInputElement;
  /** A rename request is in flight; ignore further commits until it answers. */
  busy: boolean;
  errorEl?: HTMLElement;
}

/** Same as the Explorer's default `workbench.tree.indent`. */
const INDENT = 8;
const ROW_PADDING = 8;
/** How long a dragged entry must hover a collapsed folder before it opens. */
const AUTO_EXPAND_DELAY = 500;
const DRAG_MIME = 'application/vnd.activitynote.entry';

/** Lookup tables of the active file icon theme (values are CSS class names). */
interface IconTheme {
  css: string;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  languageIds: Record<string, string>;
  languageByExtension: Record<string, string>;
  languageByFileName: Record<string, string>;
  hidesExplorerArrows: boolean;
}

const vscode = acquireVsCodeApi();
const iconThemeStyleEl = document.getElementById('icon-theme') as HTMLStyleElement;
let iconTheme: IconTheme | undefined;
/** Bumped on icon theme changes so every row gets rebuilt. */
let iconThemeVersion = 0;
const treeEl = document.getElementById('tree') as HTMLDivElement;
const rowsEl = document.getElementById('rows') as HTMLDivElement;
const welcomeEl = document.getElementById('welcome') as HTMLDivElement;

const saved = vscode.getState<SavedState>();
const expanded = new Set<string>(saved?.expanded ?? []);
let selected: string | undefined = saved?.selected;

let rootUri: string | undefined;
let nodes: TreeNode[] = [];
const nodeIndex = new Map<string, TreeNode>();
let rows: Row[] = [];
/** Row elements by URI, reused across renders so a drag source survives re-renders. */
const rowEls = new Map<string, HTMLDivElement>();
const rowSignatures = new WeakMap<HTMLElement, string>();

let editing: EditState | undefined;
/** A render was requested while the inline editor was open. */
let renderDeferred = false;
/** A node to reveal as soon as it shows up in the tree. */
let pendingReveal: string | undefined;

let drag: { uri: string; kind: EntryKind } | undefined;
let dropTarget: string | undefined;
let autoExpand: { uri: string; timer: number } | undefined;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function parentUriOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/'));
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/** Replace the `oldUri` prefix of `uri` with `newUri` (for renamed/moved folders). */
function remapUri(uri: string, oldUri: string, newUri: string): string {
  return isSameOrDescendant(uri, oldUri) ? newUri + uri.slice(oldUri.length) : uri;
}

function saveState(): void {
  vscode.setState<SavedState>({ expanded: [...expanded], selected });
}

function indexNodes(list: TreeNode[]): void {
  for (const node of list) {
    nodeIndex.set(node.uri, node);
    if (node.children) {
      indexNodes(node.children);
    }
  }
}

/**
 * The icon theme class for an entry, resolved like the Explorer does: file
 * name, then extensions from longest ("test.ts") to shortest ("ts"), then
 * language id, then the theme's default icon.
 */
function iconClassFor(node: TreeNode, open: boolean): string | undefined {
  if (!iconTheme) {
    return undefined;
  }
  const name = node.name.toLowerCase();
  if (node.kind === 'folder') {
    return open
      ? (iconTheme.folderNamesExpanded[name] ?? iconTheme.folderNames[name] ?? iconTheme.folderExpanded)
      : (iconTheme.folderNames[name] ?? iconTheme.folder);
  }
  const fromName = iconTheme.fileNames[name];
  if (fromName) {
    return fromName;
  }
  const suffixes: string[] = [];
  for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
    suffixes.push(name.slice(dot + 1));
  }
  for (const suffix of suffixes) {
    const fromExtension = iconTheme.fileExtensions[suffix];
    if (fromExtension) {
      return fromExtension;
    }
  }
  const language =
    iconTheme.languageByFileName[name] ??
    suffixes.map((suffix) => iconTheme?.languageByExtension[suffix]).find(Boolean);
  return (language && iconTheme.languageIds[language]) || iconTheme.file;
}

function expandAncestors(uri: string): void {
  if (!rootUri) {
    return;
  }
  for (let dir = parentUriOf(uri); dir.length > rootUri.length; dir = parentUriOf(dir)) {
    expanded.add(dir);
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function collectRows(list: TreeNode[], depth: number, out: Row[]): void {
  for (const node of list) {
    out.push({ node, depth });
    if (node.kind === 'folder' && expanded.has(node.uri) && node.children) {
      collectRows(node.children, depth + 1, out);
    }
  }
}

function render(): void {
  if (editing) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;
  rows = [];
  collectRows(nodes, 0, rows);

  const wanted = new Set(rows.map((row) => row.node.uri));
  for (const [uri, el] of rowEls) {
    if (!wanted.has(uri)) {
      el.remove();
      rowEls.delete(uri);
    }
  }
  // Insert/reorder without detaching rows that are already in place.
  let cursor = rowsEl.firstElementChild;
  for (const row of rows) {
    const el = rowEls.get(row.node.uri) ?? createRowEl(row.node.uri);
    updateRowEl(el, row);
    if (el === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      rowsEl.insertBefore(el, cursor);
    }
  }
  updateDropHighlight();
}

function createRowEl(uri: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'row';
  el.setAttribute('role', 'treeitem');
  el.dataset.uri = uri;
  el.draggable = true;
  rowEls.set(uri, el);
  return el;
}

function updateRowEl(el: HTMLDivElement, row: Row): void {
  const { node, depth } = row;
  const isFolder = node.kind === 'folder';
  const isOpen = isFolder && expanded.has(node.uri);
  el.classList.toggle('selected', node.uri === selected);
  el.setAttribute('aria-selected', String(node.uri === selected));
  el.setAttribute('aria-level', String(depth + 1));
  if (isFolder) {
    el.setAttribute('aria-expanded', String(isOpen));
  } else {
    el.removeAttribute('aria-expanded');
  }

  const signature = `${node.kind}|${node.name}|${depth}|${isOpen}|${iconThemeVersion}`;
  if (rowSignatures.get(el) === signature) {
    return;
  }
  rowSignatures.set(el, signature);

  el.title = node.name;
  el.style.paddingLeft = `${ROW_PADDING + depth * INDENT}px`;
  el.dataset.vscodeContext = JSON.stringify({
    webviewSection: node.kind,
    uri: node.uri,
    kind: node.kind,
    preventDefaultContextMenuItems: true,
  });

  const chevron = isFolder && !iconTheme?.hidesExplorerArrows ? (isOpen ? 'chevron-down' : 'chevron-right') : '';
  const twistie = `<span class="twistie${chevron ? ` codicon codicon-${chevron}` : ''}"></span>`;
  // Like the Explorer: no icon theme (or one without folder icons) means no icon.
  const iconClass = iconClassFor(node, isOpen);
  const icon = iconClass ? `<span class="icon ${iconClass}"></span>` : '';
  const actions = isFolder
    ? actionButton('activityNote.addNote', 'New Note', 'new-file') +
      actionButton('activityNote.newFolder', 'New Folder', 'new-folder')
    : actionButton('activityNote.openInEditor', 'Open in Editor', 'go-to-file');
  el.innerHTML = `${twistie}${icon}<span class="label"></span><span class="actions">${actions}</span>`;
  (el.querySelector('.label') as HTMLElement).textContent = node.name;
}

function actionButton(command: string, title: string, codicon: string): string {
  return `<button class="action codicon codicon-${codicon}" data-command="${command}" title="${title}" aria-label="${title}" tabindex="-1"></button>`;
}

function renderWelcome(reason: 'noFolder' | 'empty' | undefined): void {
  welcomeEl.hidden = !reason;
  if (!reason) {
    welcomeEl.replaceChildren();
    return;
  }
  const button = (label: string, command: string): string =>
    `<button class="welcome-button" data-command="${command}">${label}</button>`;
  welcomeEl.innerHTML =
    reason === 'noFolder'
      ? `<p>No notes folder selected yet.</p>
         <p>First, choose a folder where your notes will live.</p>
         ${button('Choose Notes Folder', 'activityNote.selectFolder')}`
      : `<p>No notes to show yet.</p>
         ${button('Add Note', 'activityNote.addNote')}
         ${button('New Folder', 'activityNote.newFolder')}`;
}

function selectedRowEl(): HTMLDivElement | undefined {
  return selected ? rowEls.get(selected) : undefined;
}

function scrollSelectedIntoView(): void {
  selectedRowEl()?.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ *
 * Selection & navigation
 * ------------------------------------------------------------------ */

function select(uri: string | undefined): void {
  if (selected !== uri) {
    selected = uri;
    saveState();
  }
  const node = uri ? nodeIndex.get(uri) : undefined;
  vscode.postMessage({ type: 'select', uri: node?.uri, kind: node?.kind });
  for (const [rowUri, el] of rowEls) {
    el.classList.toggle('selected', rowUri === uri);
    el.setAttribute('aria-selected', String(rowUri === uri));
  }
  scrollSelectedIntoView();
}

function setExpanded(uri: string, open: boolean): void {
  if (open) {
    expanded.add(uri);
  } else {
    expanded.delete(uri);
  }
  saveState();
  render();
}

function activate(node: TreeNode): void {
  if (node.kind === 'folder') {
    setExpanded(node.uri, !expanded.has(node.uri));
  } else {
    vscode.postMessage({ type: 'open', uri: node.uri });
  }
}

function reveal(uri: string): void {
  if (!nodeIndex.has(uri)) {
    pendingReveal = uri;
    return;
  }
  pendingReveal = undefined;
  expandAncestors(uri);
  saveState();
  render();
  select(uri);
}

function moveSelection(delta: number): void {
  if (rows.length === 0) {
    return;
  }
  const index = rows.findIndex((row) => row.node.uri === selected);
  const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : index + delta;
  select(rows[Math.max(0, Math.min(rows.length - 1, next))].node.uri);
}

treeEl.addEventListener('keydown', (e) => {
  if (editing || e.target instanceof HTMLInputElement) {
    return;
  }
  const node = selected ? nodeIndex.get(selected) : undefined;
  switch (e.key) {
    case 'ArrowDown':
      moveSelection(1);
      break;
    case 'ArrowUp':
      moveSelection(-1);
      break;
    case 'Home':
      moveSelection(-rows.length);
      break;
    case 'End':
      moveSelection(rows.length);
      break;
    case 'ArrowRight':
      if (node?.kind === 'folder') {
        if (!expanded.has(node.uri)) {
          setExpanded(node.uri, true);
        } else if (node.children?.length) {
          select(node.children[0].uri);
        }
      }
      break;
    case 'ArrowLeft':
      if (node?.kind === 'folder' && expanded.has(node.uri)) {
        setExpanded(node.uri, false);
      } else if (node && rootUri && parentUriOf(node.uri) !== rootUri) {
        select(parentUriOf(node.uri));
      }
      break;
    case 'Enter':
    case ' ':
      if (node) {
        activate(node);
      }
      break;
    default:
      // F2 (rename) and Delete are VS Code keybindings, so they stay rebindable.
      return;
  }
  e.preventDefault();
});

treeEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement) {
    return;
  }
  const button = target.closest<HTMLElement>('button[data-command]');
  const rowEl = target.closest<HTMLElement>('.row');
  const node = rowEl?.dataset.uri ? nodeIndex.get(rowEl.dataset.uri) : undefined;
  if (button) {
    e.stopPropagation();
    vscode.postMessage({ type: 'command', command: button.dataset.command, uri: node?.uri, kind: node?.kind });
    return;
  }
  if (!node) {
    return;
  }
  select(node.uri);
  activate(node);
});

treeEl.addEventListener('contextmenu', (e) => {
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (rowEl?.dataset.uri && !editing) {
    select(rowEl.dataset.uri);
  }
});

window.addEventListener('focus', () => {
  document.body.classList.add('focused');
  vscode.postMessage({ type: 'focus', focused: true });
});
window.addEventListener('blur', () => {
  document.body.classList.remove('focused');
  vscode.postMessage({ type: 'focus', focused: false });
});

/* ------------------------------------------------------------------ *
 * Inline name editing
 * ------------------------------------------------------------------ */

function startEdit(uri: string): void {
  const node = nodeIndex.get(uri);
  if (!node) {
    return;
  }
  if (editing) {
    if (editing.busy) {
      return;
    }
    cancelEdit();
  }
  expandAncestors(uri);
  saveState();
  render();
  select(uri);

  const rowEl = rowEls.get(uri);
  const labelEl = rowEl?.querySelector<HTMLElement>('.label');
  if (!rowEl || !labelEl) {
    return;
  }
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = node.name;
  input.spellcheck = false;
  input.setAttribute('aria-label', `Rename ${node.name}`);
  labelEl.replaceWith(input);
  rowEl.classList.add('editing');
  rowEl.draggable = false;

  editing = { uri, kind: node.kind, original: node.name, input, busy: false };
  vscode.postMessage({ type: 'editing', editing: true });

  // Like the Explorer: select the base name of a file, the whole folder name.
  const dot = node.name.lastIndexOf('.');
  input.focus();
  input.setSelectionRange(0, node.kind === 'note' && dot > 0 ? dot : node.name.length);

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });
  input.addEventListener('input', () => showEditError(undefined));
  input.addEventListener('blur', () => {
    if (editing?.input === input && !editing.busy) {
      commitEdit();
    }
  });
  // Clicks inside the editor must not select/toggle the row or start a drag.
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
}

function commitEdit(): void {
  if (!editing || editing.busy) {
    return;
  }
  const name = editing.input.value.trim();
  if (name === editing.original) {
    cancelEdit();
    return;
  }
  if (!name) {
    if (document.activeElement === editing.input) {
      showEditError('A file or folder name must be provided.');
    } else {
      cancelEdit();
    }
    return;
  }
  editing.busy = true;
  editing.input.readOnly = true;
  vscode.postMessage({ type: 'rename', uri: editing.uri, kind: editing.kind, name });
}

function cancelEdit(): void {
  if (!editing) {
    return;
  }
  const uri = editing.uri;
  endEdit();
  vscode.postMessage({ type: 'cancelEdit', uri });
  render();
}

/** Close the inline editor; the row is rebuilt on the next render. */
function endEdit(): void {
  if (!editing) {
    return;
  }
  const hadFocus = document.activeElement === editing.input;
  const rowEl = rowEls.get(editing.uri);
  editing = undefined;
  vscode.postMessage({ type: 'editing', editing: false });
  if (rowEl) {
    // Force the row's content to be rebuilt without the input.
    rowSignatures.delete(rowEl);
    rowEl.classList.remove('editing');
    rowEl.draggable = true;
  }
  if (hadFocus) {
    treeEl.focus();
  }
}

function showEditError(message: string | undefined): void {
  if (!editing) {
    return;
  }
  editing.errorEl?.remove();
  editing.errorEl = undefined;
  editing.input.classList.toggle('invalid', !!message);
  if (message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'rename-error';
    errorEl.textContent = message;
    editing.input.insertAdjacentElement('afterend', errorEl);
    editing.errorEl = errorEl;
  }
}

function onRenameResult(message: Extract<InboundMessage, { type: 'renameResult' }>): void {
  if (!editing || editing.uri !== message.uri) {
    return;
  }
  if (message.ok) {
    endEdit();
    remapState(message.uri, message.newUri);
    render();
    select(message.newUri);
    return;
  }
  editing.busy = false;
  editing.input.readOnly = false;
  if (document.activeElement === editing.input) {
    showEditError(message.error);
  } else {
    // The editor lost focus before the rename failed; drop it like the Explorer does.
    endEdit();
    vscode.postMessage({ type: 'error', message: message.error });
    render();
  }
}

/** Keep expansion and selection attached to an entry that was renamed or moved. */
function remapState(oldUri: string, newUri: string): void {
  const remapped = [...expanded].map((uri) => remapUri(uri, oldUri, newUri));
  expanded.clear();
  remapped.forEach((uri) => expanded.add(uri));
  if (selected) {
    selected = remapUri(selected, oldUri, newUri);
  }
  saveState();
}

/* ------------------------------------------------------------------ *
 * Drag & drop (move entries between folders)
 * ------------------------------------------------------------------ */

/** The folder a drop at `target` would move the dragged entry into. */
function dropDirFor(target: EventTarget | null): string | undefined {
  const rowEl = (target as HTMLElement | null)?.closest?.<HTMLElement>('.row');
  const node = rowEl?.dataset.uri ? nodeIndex.get(rowEl.dataset.uri) : undefined;
  if (!node) {
    return rootUri;
  }
  return node.kind === 'folder' ? node.uri : parentUriOf(node.uri);
}

function canDrop(dir: string | undefined): dir is string {
  if (!drag || !dir) {
    return false;
  }
  if (parentUriOf(drag.uri) === dir) {
    return false; // Already there.
  }
  return !(drag.kind === 'folder' && isSameOrDescendant(dir, drag.uri));
}

function setDropTarget(dir: string | undefined): void {
  if (dropTarget !== dir) {
    dropTarget = dir;
    updateDropHighlight();
  }
}

/** Highlight the target folder together with its visible content, like the Explorer. */
function updateDropHighlight(): void {
  treeEl.classList.toggle('drop-root', !!dropTarget && dropTarget === rootUri);
  for (const [uri, el] of rowEls) {
    el.classList.toggle(
      'drop-target',
      !!dropTarget && dropTarget !== rootUri && isSameOrDescendant(uri, dropTarget),
    );
  }
}

function scheduleAutoExpand(target: EventTarget | null): void {
  const rowEl = (target as HTMLElement | null)?.closest?.<HTMLElement>('.row');
  const node = rowEl?.dataset.uri ? nodeIndex.get(rowEl.dataset.uri) : undefined;
  const uri = node?.kind === 'folder' && !expanded.has(node.uri) ? node.uri : undefined;
  if (autoExpand?.uri === uri) {
    return;
  }
  cancelAutoExpand();
  if (uri) {
    autoExpand = {
      uri,
      timer: window.setTimeout(() => {
        autoExpand = undefined;
        setExpanded(uri, true);
      }, AUTO_EXPAND_DELAY),
    };
  }
}

function cancelAutoExpand(): void {
  if (autoExpand) {
    window.clearTimeout(autoExpand.timer);
    autoExpand = undefined;
  }
}

function endDrag(): void {
  drag = undefined;
  cancelAutoExpand();
  setDropTarget(undefined);
  document.body.classList.remove('dragging');
}

treeEl.addEventListener('dragstart', (e) => {
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.row');
  const node = rowEl?.dataset.uri ? nodeIndex.get(rowEl.dataset.uri) : undefined;
  if (!node || editing || !e.dataTransfer) {
    e.preventDefault();
    return;
  }
  drag = { uri: node.uri, kind: node.kind };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_MIME, node.uri);
  document.body.classList.add('dragging');
  select(node.uri);
});

treeEl.addEventListener('dragover', (e) => {
  if (!drag || !e.dataTransfer) {
    return; // Only our own entries can be dropped here.
  }
  const dir = dropDirFor(e.target);
  scheduleAutoExpand(e.target);
  if (canDrop(dir)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(dir);
  } else {
    e.dataTransfer.dropEffect = 'none';
    setDropTarget(undefined);
  }
});

treeEl.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !treeEl.contains(e.relatedTarget as Node)) {
    cancelAutoExpand();
    setDropTarget(undefined);
  }
});

treeEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const dir = dropDirFor(e.target);
  if (drag && canDrop(dir)) {
    vscode.postMessage({ type: 'move', uri: drag.uri, kind: drag.kind, targetDir: dir });
  }
  endDrag();
});

treeEl.addEventListener('dragend', () => endDrag());

/* ------------------------------------------------------------------ *
 * Messages from the extension
 * ------------------------------------------------------------------ */

welcomeEl.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('button[data-command]');
  if (button) {
    e.stopPropagation();
    vscode.postMessage({ type: 'command', command: button.dataset.command });
  }
});

window.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'tree': {
      rootUri = message.rootUri;
      nodes = message.nodes;
      nodeIndex.clear();
      indexNodes(nodes);
      // Forget folders of a previous notes folder. Missing folders under the
      // current one are kept: a rename/move result may still remap them.
      for (const uri of [...expanded]) {
        if (!rootUri || !isSameOrDescendant(uri, rootUri)) {
          expanded.delete(uri);
        }
      }
      if (selected && !nodeIndex.has(selected) && !editing) {
        selected = undefined;
      }
      saveState();
      // (Re)send the selection: it may only now resolve to a node.
      const selectedNode = selected ? nodeIndex.get(selected) : undefined;
      vscode.postMessage({ type: 'select', uri: selectedNode?.uri, kind: selectedNode?.kind });
      renderWelcome(message.empty);
      render();
      if (message.edit) {
        startEdit(message.edit);
      } else if (pendingReveal && nodeIndex.has(pendingReveal)) {
        reveal(pendingReveal);
      }
      break;
    }
    case 'reveal':
      if (!editing) {
        reveal(message.uri);
      }
      break;
    case 'edit':
      reveal(message.uri);
      startEdit(message.uri);
      break;
    case 'renameResult':
      onRenameResult(message);
      break;
    case 'moved':
      remapState(message.oldUri, message.newUri);
      expandAncestors(message.newUri);
      saveState();
      render();
      if (nodeIndex.has(message.newUri)) {
        select(message.newUri);
      } else {
        pendingReveal = message.newUri;
      }
      break;
    case 'collapseAll':
      expanded.clear();
      saveState();
      render();
      break;
    case 'iconTheme':
      iconTheme = message.data;
      iconThemeStyleEl.textContent = iconTheme?.css ?? '';
      document.body.classList.toggle('file-icons', !!iconTheme);
      iconThemeVersion++;
      render();
      break;
  }
});

if (document.hasFocus()) {
  document.body.classList.add('focused');
}
vscode.postMessage({ type: 'ready' });

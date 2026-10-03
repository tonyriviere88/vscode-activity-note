import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

declare global {
  interface Window {
    mermaid?: MermaidApi;
    __activityNote?: { mermaidSrc: string; nonce: string };
  }
}

type ViewMode = 'preview' | 'edit';
type RenderKind = 'markdown' | 'table' | 'text' | 'json' | 'mermaid';

type InboundMessage =
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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Cap rendered table rows so a huge file can't freeze the view. */
const MAX_TABLE_ROWS = 2000;

const vscode = acquireVsCodeApi();

const md = new MarkdownIt({
  html: false, // do not allow raw HTML in notes (safer)
  linkify: true,
  typographer: true,
  breaks: true,
});
md.use(taskLists, { enabled: true, label: true });

// Tag every list item with its source line so preview checkboxes can be mapped
// back to the exact line to toggle (robust against `[ ]` text inside code blocks).
md.core.ruler.push('activity_note_line_numbers', (state) => {
  for (const token of state.tokens) {
    if (token.type === 'list_item_open' && token.map) {
      token.attrSet('data-line', String(token.map[0]));
    }
  }
  return true;
});

// Open links in the user's default browser rather than inside the webview.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Turn ```mermaid fenced blocks into containers that we render after insertion.
const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  if (tokens[idx].info.trim().toLowerCase() === 'mermaid') {
    return `<pre class="mermaid">${escapeHtml(tokens[idx].content)}</pre>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

const emptyEl = document.getElementById('empty') as HTMLDivElement;
const previewEl = document.getElementById('preview') as HTMLDivElement;
const editorEl = document.getElementById('editor') as HTMLTextAreaElement;
const ghostEl = document.getElementById('ghost') as HTMLDivElement;

let hasNote = false;
let mode: ViewMode = 'preview';
let autoSave = true;
let kind: RenderKind = 'markdown';
let delimiter: string | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let ghostActive = false;

/** The completion offered after a bare bullet. */
const CHECKBOX_SUGGESTION = '[ ] ';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------------ *
 * CSV / TSV table
 * ------------------------------------------------------------------ */

/** Parse delimited text into rows of fields, honouring quoted fields per RFC 4180. */
function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  const lastRow = rows[rows.length - 1];
  if (rows.length > 1 && lastRow.length === 1 && lastRow[0] === '') {
    rows.pop();
  }
  return rows;
}

/** Guess the delimiter of a `.csv` from its first line (comma / semicolon / tab). */
function sniffDelimiter(text: string, fallback: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  let best = fallback;
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return bestCount > 0 ? best : fallback;
}

/** Build an HTML table element from parsed rows (first row is the header). */
function buildTable(rows: string[][]): HTMLTableElement {
  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (let c = 0; c < columnCount; c++) {
    const th = document.createElement('th');
    th.textContent = rows[0]?.[c] ?? '';
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const limit = Math.min(rows.length, MAX_TABLE_ROWS + 1);
  for (let r = 1; r < limit; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < columnCount; c++) {
      const td = document.createElement('td');
      td.textContent = rows[r][c] ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function renderTable(): void {
  previewEl.className = 'table-view';
  previewEl.replaceChildren();

  const text = editorEl.value;
  if (text.trim() === '') {
    previewEl.appendChild(note('(empty file)'));
    return;
  }

  const sep = delimiter === '\t' ? '\t' : sniffDelimiter(text, delimiter ?? ',');
  const rows = parseDelimited(text, sep);
  previewEl.appendChild(buildTable(rows));

  const dataRows = Math.max(rows.length - 1, 0);
  if (dataRows > MAX_TABLE_ROWS) {
    previewEl.appendChild(
      note(`Showing the first ${MAX_TABLE_ROWS} of ${dataRows} rows — switch to Edit to see the whole file.`),
    );
  }
}

/* ------------------------------------------------------------------ *
 * JSON tree
 * ------------------------------------------------------------------ */

/** Remove `//` and block comments and trailing commas so JSONC parses. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function isJsonContainer(value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object';
}

function jsonPrimitiveSpan(value: JsonValue): HTMLElement {
  const span = document.createElement('span');
  if (value === null) {
    span.className = 'json-null';
    span.textContent = 'null';
  } else if (typeof value === 'string') {
    span.className = 'json-string';
    span.textContent = JSON.stringify(value);
  } else if (typeof value === 'number') {
    span.className = 'json-number';
    span.textContent = String(value);
  } else {
    span.className = 'json-boolean';
    span.textContent = String(value);
  }
  return span;
}

function buildJsonEntry(key: string | undefined, value: JsonValue): HTMLElement {
  const container = isJsonContainer(value);
  const entries: [string, JsonValue][] = container
    ? Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as [string, JsonValue])
      : Object.entries(value)
    : [];

  if (!container || entries.length === 0) {
    const line = document.createElement('div');
    line.className = 'json-line';
    appendKey(line, key);
    if (!container) {
      line.appendChild(jsonPrimitiveSpan(value));
    } else {
      const bracket = document.createElement('span');
      bracket.className = 'json-bracket';
      bracket.textContent = Array.isArray(value) ? '[ ]' : '{ }';
      line.appendChild(bracket);
    }
    return line;
  }

  const isArray = Array.isArray(value);
  const details = document.createElement('details');
  details.open = true;
  details.className = 'json-node';

  const summary = document.createElement('summary');
  appendKey(summary, key);
  const badge = document.createElement('span');
  badge.className = 'json-bracket';
  badge.textContent = isArray ? `[${entries.length}]` : `{${entries.length}}`;
  summary.appendChild(badge);
  details.appendChild(summary);

  const children = document.createElement('div');
  children.className = 'json-children';
  for (const [childKey, childValue] of entries) {
    children.appendChild(buildJsonEntry(isArray ? undefined : childKey, childValue));
  }
  details.appendChild(children);
  return details;
}

function appendKey(parent: HTMLElement, key: string | undefined): void {
  if (key === undefined) {
    return;
  }
  const keyEl = document.createElement('span');
  keyEl.className = 'json-key';
  keyEl.textContent = key;
  parent.appendChild(keyEl);
  parent.appendChild(document.createTextNode(': '));
}

function renderJson(): void {
  let data: JsonValue;
  try {
    data = JSON.parse(stripJsonComments(editorEl.value)) as JsonValue;
  } catch (err) {
    previewEl.className = 'plaintext';
    previewEl.textContent = `⚠ Invalid JSON: ${err instanceof Error ? err.message : String(err)}\n\n${editorEl.value}`;
    return;
  }
  previewEl.className = 'json-view';
  previewEl.replaceChildren(buildJsonEntry(undefined, data));
}

/* ------------------------------------------------------------------ *
 * Mermaid diagrams (lazy-loaded)
 * ------------------------------------------------------------------ */

let mermaidLoad: Promise<MermaidApi> | undefined;
let mermaidSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (window.mermaid) {
    return Promise.resolve(window.mermaid);
  }
  if (!mermaidLoad) {
    mermaidLoad = new Promise<MermaidApi>((resolve, reject) => {
      const config = window.__activityNote;
      if (!config) {
        reject(new Error('missing webview config'));
        return;
      }
      const script = document.createElement('script');
      script.nonce = config.nonce;
      script.src = config.mermaidSrc;
      script.onload = () =>
        window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid unavailable'));
      script.onerror = () => reject(new Error('failed to load mermaid'));
      document.head.appendChild(script);
    });
  }
  return mermaidLoad;
}

async function runMermaid(container: HTMLElement): Promise<void> {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>('pre.mermaid:not(.rendered)'),
  ).filter((block) => (block.textContent ?? '').trim() !== '');
  if (blocks.length === 0) {
    return;
  }

  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid();
  } catch {
    for (const block of blocks) {
      block.classList.add('mermaid-error', 'rendered');
      block.textContent = 'Could not load the diagram renderer.';
    }
    return;
  }

  const dark =
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });

  for (const block of blocks) {
    const source = block.textContent ?? '';
    try {
      const { svg } = await mermaid.render(`activity-note-mermaid-${mermaidSeq++}`, source);
      block.innerHTML = svg;
      block.classList.add('rendered');
    } catch (err) {
      block.classList.add('mermaid-error', 'rendered');
      block.textContent = `Mermaid error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

function renderMermaidFile(): void {
  previewEl.className = 'mermaid-view';
  previewEl.replaceChildren();
  if (editorEl.value.trim() === '') {
    previewEl.appendChild(note('(empty file)'));
    return;
  }
  const pre = document.createElement('pre');
  pre.className = 'mermaid';
  pre.textContent = editorEl.value;
  previewEl.appendChild(pre);
  void runMermaid(previewEl);
}

/* ------------------------------------------------------------------ *
 * Interactive markdown task lists
 * ------------------------------------------------------------------ */

/** Make rendered task-list checkboxes clickable and persist ticks to the source. */
function wireTaskCheckboxes(): void {
  const boxes = previewEl.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox');
  boxes.forEach((box) => {
    box.disabled = false;
    box.addEventListener('change', () => {
      const line = box.closest('li[data-line]')?.getAttribute('data-line');
      if (line !== null && line !== undefined) {
        toggleTaskAtLine(Number(line), box.checked);
      }
    });
  });
}

/** Flip the `[ ]`/`[x]` marker on a specific source line and save. */
function toggleTaskAtLine(lineIndex: number, checked: boolean): void {
  const lines = editorEl.value.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return;
  }
  const marker = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\]/;
  const updated = lines[lineIndex].replace(marker, (_m, prefix) => `${prefix}[${checked ? 'x' : ' '}]`);
  if (updated === lines[lineIndex]) {
    return;
  }
  lines[lineIndex] = updated;
  editorEl.value = lines.join('\n');
  vscode.postMessage({ type: 'save', content: editorEl.value });
}

/* ------------------------------------------------------------------ *
 * Shared rendering
 * ------------------------------------------------------------------ */

function note(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'preview-note';
  p.textContent = text;
  return p;
}

function render(): void {
  emptyEl.hidden = hasNote;

  if (!hasNote) {
    previewEl.hidden = true;
    editorEl.hidden = true;
    hideGhost();
    return;
  }

  if (mode === 'preview') {
    if (kind === 'markdown') {
      previewEl.className = 'markdown-body';
      previewEl.innerHTML = md.render(editorEl.value);
      wireTaskCheckboxes();
      void runMermaid(previewEl);
    } else if (kind === 'table') {
      renderTable();
    } else if (kind === 'json') {
      renderJson();
    } else if (kind === 'mermaid') {
      renderMermaidFile();
    } else {
      // Plain-text files are shown verbatim; textContent escapes automatically.
      previewEl.className = 'plaintext';
      previewEl.textContent = editorEl.value;
    }
    previewEl.hidden = false;
    editorEl.hidden = true;
    previewEl.scrollTop = 0;
    hideGhost();
  } else {
    previewEl.hidden = true;
    editorEl.hidden = false;
    editorEl.focus();
    updateGhost();
  }
}

/* ------------------------------------------------------------------ *
 * Editing / saving
 * ------------------------------------------------------------------ */

function flushSave(): void {
  if (!hasNote) {
    return;
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  vscode.postMessage({ type: 'save', content: editorEl.value });
}

function scheduleSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    vscode.postMessage({ type: 'save', content: editorEl.value });
  }, 500);
}

/** Replace the current selection, keeping the native undo stack intact. */
function replaceSelectionWith(text: string): void {
  if (!document.execCommand('insertText', false, text)) {
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    editorEl.setRangeText(text, start, end, 'end');
    if (autoSave) {
      scheduleSave();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Checkbox completion (ghost text after a bare bullet)
 * ------------------------------------------------------------------ */

function hideGhost(): void {
  if (!ghostActive) {
    return;
  }
  ghostActive = false;
  ghostEl.hidden = true;
  ghostEl.replaceChildren();
}

/** Show a "[ ] " suggestion when the caret sits at the end of a bare bullet. */
function updateGhost(): void {
  if (!hasNote || mode !== 'edit' || kind !== 'markdown') {
    hideGhost();
    return;
  }
  const caret = editorEl.selectionStart;
  if (caret !== editorEl.selectionEnd) {
    hideGhost();
    return;
  }
  const value = editorEl.value;
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  const lineEndIdx = value.indexOf('\n', caret);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  // Only when the caret is at the end of a line that is just an empty bullet.
  if (caret !== lineEnd || !/^[ \t]*[-*+][ \t]+$/.test(value.slice(lineStart, lineEnd))) {
    hideGhost();
    return;
  }

  const suggestion = document.createElement('span');
  suggestion.className = 'ghost-text';
  suggestion.textContent = CHECKBOX_SUGGESTION;
  // Mirror the whole document so the suggestion lands exactly at the caret.
  ghostEl.replaceChildren(
    document.createTextNode(value.slice(0, caret)),
    suggestion,
    document.createTextNode(value.slice(caret)),
  );
  ghostEl.hidden = false;
  ghostEl.scrollTop = editorEl.scrollTop;
  ghostEl.scrollLeft = editorEl.scrollLeft;
  ghostActive = true;
}

editorEl.addEventListener('input', () => {
  if (hasNote && autoSave) {
    scheduleSave();
  }
  updateGhost();
});

editorEl.addEventListener('keyup', updateGhost);
editorEl.addEventListener('click', updateGhost);
editorEl.addEventListener('scroll', () => {
  if (ghostActive) {
    ghostEl.scrollTop = editorEl.scrollTop;
    ghostEl.scrollLeft = editorEl.scrollLeft;
  }
});

// Never lose the last edits when leaving the editor.
editorEl.addEventListener('blur', () => {
  flushSave();
  hideGhost();
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    flushSave();
  }
});

// Tab accepts a pending checkbox suggestion, otherwise inserts a tab.
editorEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && ghostActive) {
    hideGhost();
    return;
  }
  if (event.key !== 'Tab') {
    return;
  }
  event.preventDefault();
  if (ghostActive) {
    replaceSelectionWith(CHECKBOX_SUGGESTION);
    hideGhost();
  } else {
    replaceSelectionWith('\t');
  }
});

// Continue markdown lists when Enter is pressed on a list item.
editorEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
    return;
  }
  const caret = editorEl.selectionStart;
  if (caret !== editorEl.selectionEnd) {
    return; // let a selection be replaced by a normal newline
  }

  const value = editorEl.value;
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  const lineEndIdx = value.indexOf('\n', caret);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const line = value.slice(lineStart, lineEnd);

  // indent | bullet (-,*,+ or 1. / 1)) | spacing | optional checkbox | content
  const match = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/);
  if (!match) {
    return; // not a list item — let Enter insert a normal newline
  }
  const [, indent = '', bullet = '', spacing = '', checkbox = '', content = ''] = match;

  event.preventDefault();

  if (content.trim() === '') {
    // Empty item: a second Enter clears the marker and ends the list.
    editorEl.selectionStart = lineStart;
    editorEl.selectionEnd = lineEnd;
    replaceSelectionWith('');
  } else {
    const ordered = bullet.match(/^(\d+)([.)])$/);
    const nextBullet = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : bullet;
    // Carry the checkbox over as unchecked, keeping its original spacing.
    const nextCheckbox = checkbox ? checkbox.replace(/\[[ xX]\]/, '[ ]') : '';
    replaceSelectionWith(`\n${indent}${nextBullet}${spacing}${nextCheckbox}`);
  }
});

window.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'load':
      hasNote = true;
      mode = message.mode;
      autoSave = message.autoSave;
      kind = message.kind;
      delimiter = message.delimiter;
      editorEl.value = message.content;
      render();
      break;
    case 'mode':
      // Persist current edits before rendering a preview of them.
      if (message.mode === 'preview' && mode === 'edit') {
        flushSave();
      }
      mode = message.mode;
      render();
      break;
    case 'empty':
      hasNote = false;
      mode = 'preview';
      editorEl.value = '';
      render();
      break;
  }
});

// Tell the host we are ready to receive the current note (handles reloads).
vscode.postMessage({ type: 'ready' });

import * as vscode from 'vscode';

/**
 * Lookup tables of the active file icon theme, ready for the webview. Every
 * value is a CSS class name defined in `css`.
 */
export interface IconThemeData {
  css: string;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  languageIds: Record<string, string>;
  /** Language id by lower-cased file extension (without dot) and by file name. */
  languageByExtension: Record<string, string>;
  languageByFileName: Record<string, string>;
  hidesExplorerArrows: boolean;
}

/** The subset of the icon theme JSON format that matters for a file tree. */
interface IconThemeSection {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

interface IconThemeJson extends IconThemeSection {
  iconDefinitions?: Record<string, IconDefinition>;
  fonts?: { id: string; src: { path: string; format: string }[]; weight?: string; style?: string; size?: string }[];
  light?: IconThemeSection;
  highContrast?: IconThemeSection;
  hidesExplorerArrows?: boolean;
}

interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

/** The icon theme selected in `workbench.iconTheme`, located on disk. */
export interface IconThemeSource {
  /** The theme JSON file; icon and font paths are relative to it. */
  themeUri: vscode.Uri;
  /** Root of the contributing extension, to be allowed as a webview resource root. */
  extensionUri: vscode.Uri;
  json: IconThemeJson;
}

/** Find and parse the active file icon theme, or `undefined` when icons are off. */
export async function loadIconTheme(): Promise<IconThemeSource | undefined> {
  const themeId = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  if (!themeId) {
    return undefined;
  }
  for (const extension of vscode.extensions.all) {
    const themes: { id: string; path: string }[] = extension.packageJSON?.contributes?.iconThemes ?? [];
    const theme = themes.find((t) => t.id === themeId);
    if (!theme) {
      continue;
    }
    const themeUri = vscode.Uri.joinPath(extension.extensionUri, theme.path);
    try {
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(themeUri));
      return { themeUri, extensionUri: extension.extensionUri, json: parseJsonc(raw) as IconThemeJson };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Turn a theme into CSS classes and lookup tables for the current colour theme kind. */
export function buildIconThemeData(source: IconThemeSource, webview: vscode.Webview): IconThemeData {
  const { json } = source;
  const themeDir = vscode.Uri.joinPath(source.themeUri, '..');
  const kind = vscode.window.activeColorTheme.kind;
  // Same variant choice as the workbench: light and high-contrast sections
  // override the base tables for those colour themes.
  const variant: IconThemeSection | undefined =
    kind === vscode.ColorThemeKind.HighContrast
      ? json.highContrast
      : kind === vscode.ColorThemeKind.HighContrastLight
        ? (json.highContrast ?? json.light)
        : kind === vscode.ColorThemeKind.Light
          ? json.light
          : undefined;

  const classes = new Map<string, string>();
  const rules: string[] = [];
  const fontIds = new Map<string, string>();
  const defaultFont = json.fonts?.[0];

  json.fonts?.forEach((font, index) => {
    const family = `icon-font-${index}`;
    fontIds.set(font.id, family);
    const src = font.src
      .map((s) => `url("${webview.asWebviewUri(vscode.Uri.joinPath(themeDir, s.path))}") format("${cssString(s.format)}")`)
      .join(', ');
    rules.push(
      `@font-face { font-family: "${family}"; src: ${src}; font-weight: ${cssToken(font.weight ?? 'normal')};` +
        ` font-style: ${cssToken(font.style ?? 'normal')}; font-display: block; }`,
    );
  });

  /** Class for an icon definition id, emitting its CSS rule on first use. */
  const classFor = (id: string | undefined): string | undefined => {
    if (!id) {
      return undefined;
    }
    const existing = classes.get(id);
    if (existing) {
      return existing;
    }
    const definition = json.iconDefinitions?.[id];
    if (!definition) {
      return undefined;
    }
    const name = `ti-${classes.size}`;
    classes.set(id, name);
    if (definition.iconPath) {
      const url = webview.asWebviewUri(vscode.Uri.joinPath(themeDir, definition.iconPath));
      rules.push(`.${name} { background-image: url("${url}"); }`);
    } else if (definition.fontCharacter) {
      const fontId = definition.fontId ?? defaultFont?.id;
      const family = (fontId && fontIds.get(fontId)) ?? 'icon-font-0';
      const font = json.fonts?.find((f) => f.id === fontId);
      const size = definition.fontSize ?? font?.size;
      const color = definition.fontColor && /^#[0-9a-f]{3,8}$/i.test(definition.fontColor) ? definition.fontColor : undefined;
      rules.push(
        `.${name}::before { content: "${cssString(definition.fontCharacter)}"; font-family: "${family}";` +
          (size ? ` font-size: ${cssToken(size)};` : '') +
          (color ? ` color: ${color};` : '') +
          ' }',
      );
    }
    return name;
  };

  /** Merge a base table with its variant override, lower-casing keys and mapping ids to classes. */
  const table = (key: Exclude<keyof IconThemeSection, 'file' | 'folder' | 'folderExpanded'>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, id] of Object.entries({ ...json[key], ...variant?.[key] })) {
      const cls = classFor(id);
      if (cls) {
        out[name.toLowerCase()] = cls;
      }
    }
    return out;
  };

  const folder = classFor(variant?.folder ?? json.folder);
  const { languageByExtension, languageByFileName } = languageTables();
  return {
    file: classFor(variant?.file ?? json.file),
    folder,
    folderExpanded: classFor(variant?.folderExpanded ?? json.folderExpanded) ?? folder,
    fileExtensions: table('fileExtensions'),
    fileNames: table('fileNames'),
    folderNames: table('folderNames'),
    folderNamesExpanded: table('folderNamesExpanded'),
    languageIds: table('languageIds'),
    languageByExtension,
    languageByFileName,
    hidesExplorerArrows: !!json.hidesExplorerArrows,
    css: rules.join('\n'),
  };
}

/** Language ids contributed by all extensions, keyed by file extension and file name. */
function languageTables(): { languageByExtension: Record<string, string>; languageByFileName: Record<string, string> } {
  const languageByExtension: Record<string, string> = {};
  const languageByFileName: Record<string, string> = {};
  for (const extension of vscode.extensions.all) {
    const languages: { id: string; extensions?: string[]; filenames?: string[] }[] =
      extension.packageJSON?.contributes?.languages ?? [];
    for (const language of languages) {
      for (const ext of language.extensions ?? []) {
        languageByExtension[ext.replace(/^\./, '').toLowerCase()] ??= language.id;
      }
      for (const fileName of language.filenames ?? []) {
        languageByFileName[fileName.toLowerCase()] ??= language.id;
      }
    }
  }
  return { languageByExtension, languageByFileName };
}

/** Escape a value for use inside a double-quoted CSS string. */
function cssString(value: string): string {
  // Theme files write glyphs as `\E001`, which is already a valid CSS escape.
  return value.replace(/["\n\r<>]/g, '');
}

/** Keep only characters that are safe in a bare CSS value (`150%`, `bold`, …). */
function cssToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9.%-]/g, '');
}

/** Parse JSON that may contain comments and trailing commas (theme files often do). */
function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[++i] ?? '';
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) {
        break;
      }
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

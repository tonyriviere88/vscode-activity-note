# Activity Note

Add, edit and read markdown (and other text) notes right from the VS Code
activity bar.

Activity Note puts a dedicated panel in the activity bar with two parts:

1. **Notes** — a tree to add, delete, rename and select your notes, organise
   them into sub-folders, and pick the folder where they are stored. The active
   folder is shown in the view's title bar as `name (path)`.
2. **Note** — a content viewer with two modes (toggled from the view's title
   bar). The open note's file name is shown in the title bar.
   - **Preview** renders each format nicely (see below); other text files are
     shown as-is.
   - **Edit** is a simple editor that saves as you type.

### Preview per format

| Format | Preview |
| --- | --- |
| `md` / `markdown` / `mdx` | Rendered markdown, incl. GitHub-style task lists (`- [ ]`, tickable right in the preview) and ` ```mermaid ` diagrams |
| `csv` / `tsv` | Table (with automatic comma/semicolon/tab detection for `.csv`) |
| `json` / `jsonc` | Collapsible, colour-coded tree (comments & trailing commas tolerated) |
| `mmd` / `mermaid` | Rendered [Mermaid](https://mermaid.js.org/) diagram |
| everything else | Plain text |

Your notes are plain text files in a folder you choose, so they stay yours —
back them up, sync them, or edit them with any other tool.

## Features

- 📁 **Pick any folder** to store your notes (per-user, remembered across sessions).
- 🌳 **Organise notes in sub-folders** — the list is a full tree you can nest.
- 📄 **Rich previews per format** — markdown (with task lists & mermaid),
  `.csv`/`.tsv` as tables, `.json`/`.jsonc` as a tree, `.mmd` diagrams, and plain
  text for the rest. The extension list is configurable.
- ➕ **Add** notes and folders, ✏️ **rename** and 🗑️ **delete** them (right-click a
  folder to create items inside it).
- 👁️ **Preview / Edit toggle** in the view's title bar.
- 💾 **Autosave** while you type (configurable), plus `Ctrl`/`Cmd`+`S` to save now.
- 🎨 Rendered markdown and editor both follow your current VS Code theme.

## Getting started

1. Open the **Activity Note** icon in the activity bar.
2. Click **Choose Notes Folder** and pick where your notes should live.
3. Click **+** to add your first note — it opens straight in edit mode.
4. Toggle **Preview** to read it rendered.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `activityNote.notesFolder` | `""` | Absolute path to the notes folder. When set, it overrides the folder chosen via the button. |
| `activityNote.autoSave` | `true` | Automatically save edits shortly after you stop typing. |
| `activityNote.fileExtensions` | `md, markdown, mdx, txt, …` | File extensions that appear in the notes tree. Markdown extensions are rendered in preview. |
| `activityNote.defaultExtension` | `md` | Extension used for new notes when you don't type one yourself. |

## Developing

```bash
npm install      # install dependencies
npm run compile  # build once
npm run watch    # rebuild on change
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the
extension loaded.

## How it works

- The **Notes** view is a hierarchical `TreeDataProvider` listing sub-folders and
  every supported text file under the selected folder.
- The **Note** view is a `WebviewViewProvider`. Markdown is rendered inside the
  webview with [`markdown-it`](https://github.com/markdown-it/markdown-it); the
  extension host reads and writes the underlying files.
- Both bundles are built with [esbuild](https://esbuild.github.io/) (see
  `esbuild.js`).

## License

MIT

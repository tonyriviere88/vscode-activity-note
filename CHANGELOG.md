# Change Log

All notable changes to the Activity Note extension are documented here.

## [0.1.0] - Initial release

- Activity bar panel with a **Notes** tree and a **Note** content viewer.
- Choose a folder to store notes; the choice is remembered across sessions and
  shown as `name (path)` in the Notes title bar.
- Hierarchical notes: organise notes into nested sub-folders.
- Add notes and sub-folders, rename and delete them (create inside a folder via
  its right-click menu).
- Support for many text file extensions (configurable via
  `activityNote.fileExtensions`); the open note's file name is shown in the
  Note view's title bar.
- Preview mode renders each format richly — markdown (with GitHub-style task
  lists you can tick/untick right in the preview, and ` ```mermaid ` diagrams),
  `.csv`/`.tsv` as a table (with automatic
  comma/semicolon/tab detection), `.json`/`.jsonc` as a collapsible tree
  (comments and trailing commas tolerated), and `.mmd`/`.mermaid` as diagrams —
  and shows other text files as-is. Mermaid is loaded on demand so it never
  weighs down notes that don't use it. Edit mode is a simple text editor; the
  mode is toggled from the view's title bar.
- Smart list continuation in the editor: pressing Enter on a bullet, numbered,
  or checkbox item starts a fresh item (numbers increment, checkboxes reset to
  unchecked); pressing Enter again on an empty item removes the marker.
- Checkbox completion: typing a bare bullet (`- `) in a markdown note shows an
  inline `[ ] ` suggestion; press Tab to turn the item into a checkbox.
- Autosave while typing, plus `Ctrl`/`Cmd`+`S` to save on demand.
- Rendered markdown and editor follow the active VS Code theme.

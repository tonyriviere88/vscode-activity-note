// Bundled separately to media/mermaid.js and injected into the webview on
// demand (only when a note actually contains a diagram), so the heavy mermaid
// library never weighs down the main viewer bundle.
import mermaid from 'mermaid';

(window as unknown as { mermaid: typeof mermaid }).mermaid = mermaid;

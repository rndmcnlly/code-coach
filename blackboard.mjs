// =========================================================================
// <black-board> : shared markdown scratchpad
//
// A contenteditable div that renders markdown live.
// The agent can read and write it; the human can edit it directly.
// Changes quiesce after a short pause before notifying the agent.
//
// Rendering: uses marked (already loaded in the page) for HTML output.
// Editing: contenteditable div -- the human edits rendered HTML inline.
//   On agent write: content is set as markdown and re-rendered.
//   On read: raw markdown is returned (extracted from a hidden mirror).
//
// Methods (called by boot.mjs):
//   getContent()        – current markdown string
//   setContent(md)      – set content from agent (renders immediately, no quiescence)
//   appendContent(md)   – append markdown block (agent use)
//
// Callbacks:
//   onQuiesce(markdown) – called when human edits stabilize
//
// Events dispatched on document:
//   "blackboard-changed"  – detail: { markdown } (quiesced)
// =========================================================================

import { marked } from "https://esm.run/marked";

// Configure marked: safe, breaks on newline, linkify URLs
marked.setOptions({ breaks: true, gfm: true });

// How long after the last keystroke before we fire quiescence (ms)
const QUIESCE_MS = 2000;

class BlackBoard extends HTMLElement {
  #renderEl = null;    // contenteditable div showing rendered markdown
  #mirrorEl = null;    // hidden textarea holding raw markdown source
  #quiesceTimer = null;
  #lastNotifiedMd = "";

  onQuiesce = () => {};

  connectedCallback() {
    this.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;";

    // Header
    const header = document.createElement("div");
    header.id = "blackboard-header";
    header.textContent = "Blackboard";
    this.appendChild(header);

    // Hidden markdown mirror (source of truth for agent reads)
    this.#mirrorEl = document.createElement("textarea");
    this.#mirrorEl.style.display = "none";
    this.#mirrorEl.value = "";
    this.appendChild(this.#mirrorEl);

    // Rendered contenteditable area
    this.#renderEl = document.createElement("div");
    this.#renderEl.id = "blackboard-content";
    this.#renderEl.contentEditable = "true";
    this.#renderEl.setAttribute("spellcheck", "false");
    this.#renderEl.setAttribute("placeholder", "Shared scratchpad. Agent and human both write here...");
    this.appendChild(this.#renderEl);

    // On human input: update mirror, schedule quiescence
    this.#renderEl.addEventListener("input", () => {
      // Extract markdown from the contenteditable HTML (best-effort)
      this.#mirrorEl.value = this.#htmlToMarkdown(this.#renderEl.innerHTML);
      this.#scheduleQuiesce();
    });

    // On paste: convert to plain text to avoid HTML soup
    this.#renderEl.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, text);
    });
  }

  // ---- Public API ----

  getContent() {
    return this.#mirrorEl?.value ?? "";
  }

  setContent(md) {
    if (!this.#renderEl) return;
    this.#mirrorEl.value = md;
    this.#renderEl.innerHTML = marked.parse(md);
    this.#lastNotifiedMd = md;
  }

  appendContent(md) {
    const current = this.#mirrorEl.value;
    const separator = current.trim() ? "\n\n" : "";
    this.setContent(current + separator + md);
  }

  // ---- Private ----

  #scheduleQuiesce() {
    clearTimeout(this.#quiesceTimer);
    this.#quiesceTimer = setTimeout(() => {
      const md = this.#mirrorEl.value;
      if (md !== this.#lastNotifiedMd) {
        this.#lastNotifiedMd = md;
        this.onQuiesce(md);
        document.dispatchEvent(new CustomEvent("blackboard-changed", { detail: { markdown: md } }));
      }
    }, QUIESCE_MS);
  }

  // Best-effort HTML -> markdown for contenteditable output.
  // Handles the most common cases: bold, italic, links, headings, lists.
  // For most usage (short notes, doc links) this is sufficient.
  #htmlToMarkdown(html) {
    // Use a temporary div to traverse the DOM
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return this.#nodeToMarkdown(tmp).trim();
  }

  #nodeToMarkdown(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        const inner = this.#nodeToMarkdown(child);
        switch (tag) {
          case "br":    out += "\n"; break;
          case "p":     out += inner + "\n\n"; break;
          case "div":   out += inner + "\n"; break;
          case "strong": case "b": out += `**${inner}**`; break;
          case "em": case "i":     out += `*${inner}*`; break;
          case "code":  out += `\`${inner}\``; break;
          case "pre":   out += `\`\`\`\n${inner}\n\`\`\`\n`; break;
          case "a": {
            const href = child.getAttribute("href") ?? "";
            out += `[${inner}](${href})`;
            break;
          }
          case "h1": out += `# ${inner}\n\n`; break;
          case "h2": out += `## ${inner}\n\n`; break;
          case "h3": out += `### ${inner}\n\n`; break;
          case "ul": out += inner + "\n"; break;
          case "ol": out += inner + "\n"; break;
          case "li": out += `- ${inner}\n`; break;
          case "hr": out += "---\n\n"; break;
          default: out += inner; break;
        }
      }
    }
    return out;
  }
}
customElements.define("black-board", BlackBoard);

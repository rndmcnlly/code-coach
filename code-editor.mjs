// =========================================================================
// <code-editor> : Monaco editor + decorations + annotations + quick-fix
//
// Methods:
//   getValue()                      – current source text
//   getPosition()                   – {lineNumber, column}
//   getSelection()                  – Monaco Selection or null
//   getLineContent(n)               – text of line n
//   getLineCount()                  – total lines
//   editCode({startLine, endLine, newText})
//   highlightLines({startLine, endLine, message, linkUrl?, linkLabel?})
//   clearHighlights()
//   getCode()                       – numbered source for LLM context
//   suggestFix({line, oldText, newText, message})
//   getLineScreenPos(lineNumber)    – {x,y} in viewport coords
// Events dispatched on document:
//   "code-changed"                  – detail: { code }
//   "selection-changed"             – detail: { startLine, endLine, text } | null
//   "annotation-dismissed"          – detail: { startLine, endLine, message }
//   "quickfix-applied"              – detail: { line, message }
//   "quickfix-dismissed"            – detail: { line, message }
// =========================================================================
import { escapeHtml } from "./utils.mjs";
import { STARTER_CODE } from "./starter-code.mjs";

class CodeEditor extends HTMLElement {
  #editor = null;
  #activeDecorations = [];
  #annotationStyleEl = null;
  #activeAnnotation = null;
  #activeQuickFix = null;
  #initResolve = null;
  #initPromise = null;

  constructor() {
    super();
    this.#initPromise = new Promise(r => { this.#initResolve = r; });
  }

  /** Resolves when Monaco is loaded and editor is ready. */
  get ready() { return this.#initPromise; }

  connectedCallback() {
    this.#initMonaco();
  }

  // ---- Public API ----

  getValue() { return this.#editor?.getValue() ?? ""; }
  getPosition() { return this.#editor?.getPosition(); }
  getLineCount() { return this.#editor?.getModel()?.getLineCount() ?? 0; }
  getLineContent(n) { return this.#editor?.getModel()?.getLineContent(n) ?? ""; }

  getSelection() {
    if (!this.#editor) return null;
    const sel = this.#editor.getSelection();
    if (!sel || sel.isEmpty()) return null;
    const text = this.#editor.getModel().getValueInRange(sel);
    return { startLine: sel.startLineNumber, endLine: sel.endLineNumber, text };
  }

  /** Get numbered source code for LLM context. */
  getCode() {
    if (!this.#editor) return { error: "Editor not ready" };
    const code = this.#editor.getValue();
    const numbered = code.split("\n").map((line, i) => `${i + 1}: ${line}`).join("\n");
    return { code: numbered, lineCount: this.#editor.getModel().getLineCount(), note: "Line numbers are 1-indexed." };
  }

  editCode({ startLine, endLine, newText }) {
    if (!this.#editor) return { error: "Editor not ready" };
    const model = this.#editor.getModel();
    const totalLines = model.getLineCount();
    startLine = Math.max(1, Math.min(startLine, totalLines));
    endLine = Math.max(startLine, Math.min(endLine, totalLines));
    const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
    this.#editor.executeEdits("code-coach", [{ range, text: newText, forceMoveMarkers: true }]);
    return { success: true, linesAffected: `${startLine}-${endLine}`, newLineCount: model.getLineCount() };
  }

  highlightLines({ startLine, endLine, message, linkUrl, linkLabel }) {
    if (!this.#editor) return { error: "Editor not ready" };
    this.clearHighlights();

    const model = this.#editor.getModel();
    const totalLines = model.getLineCount();
    startLine = Math.max(1, Math.min(startLine, totalLines));
    endLine = Math.max(startLine, Math.min(endLine, totalLines));

    let hoverMessage = message;
    if (linkUrl) hoverMessage += `\n\n[${linkLabel || "docs"}](${linkUrl})`;

    let afterText = `  \u25B8 ${message}`;
    if (linkUrl) afterText += ` (${linkLabel || "docs"})`;
    const cssContent = afterText.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ");

    if (this.#annotationStyleEl) this.#annotationStyleEl.remove();
    this.#annotationStyleEl = document.createElement("style");
    this.#annotationStyleEl.textContent = `
      .coach-inline-annotation::after {
        content: '${cssContent}';
        color: #569cd6aa; font-style: italic; margin-left: 1.5em;
        font-size: 0.85em; pointer-events: none;
      }
    `;
    document.head.appendChild(this.#annotationStyleEl);

    this.#activeDecorations = this.#editor.deltaDecorations([], [
      {
        range: new monaco.Range(startLine, 1, endLine, 1),
        options: {
          isWholeLine: true,
          className: "coach-highlight-line",
          glyphMarginClassName: "coach-glyph",
          hoverMessage: { value: hoverMessage, isTrusted: true },
        }
      },
      {
        range: new monaco.Range(startLine, 1, startLine, model.getLineMaxColumn(startLine)),
        options: { afterContentClassName: "coach-inline-annotation" }
      }
    ]);

    this.#activeAnnotation = { startLine, endLine, message };
    this.#editor.revealLineInCenterIfOutsideViewport(startLine);

    // Particles at annotation
    requestAnimationFrame(() => {
      const pos = this.getLineScreenPos(startLine);
      if (pos) document.dispatchEvent(new CustomEvent("particles-spawn", { detail: pos }));
    });

    return { success: true, highlighted: `lines ${startLine}-${endLine}` };
  }

  clearHighlights() {
    if (!this.#editor) return { error: "Editor not ready" };
    if (this.#activeDecorations.length) {
      this.#activeDecorations = this.#editor.deltaDecorations(this.#activeDecorations, []);
    }
    if (this.#annotationStyleEl) { this.#annotationStyleEl.remove(); this.#annotationStyleEl = null; }
    this.#activeAnnotation = null;
    return { success: true };
  }

  suggestFix({ line, oldText, newText, message }) {
    if (!this.#editor) return { error: "Editor not ready" };
    this.#clearQuickFix();

    const model = this.#editor.getModel();
    const totalLines = model.getLineCount();
    line = Math.max(1, Math.min(line, totalLines));
    const lineContent = model.getLineContent(line);
    if (!lineContent.includes(oldText)) return { error: `"${oldText}" not found on line ${line}` };

    const decorations = this.#editor.deltaDecorations([], [{
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: "coach-highlight-line" }
    }]);

    const widgetId = `coach-quickfix-${Date.now()}`;
    const widget = {
      getId: () => widgetId,
      getDomNode: () => {
        const node = document.createElement("div");
        node.className = "coach-quickfix";
        node.innerHTML = `
          <span class="qf-msg">${escapeHtml(message)}</span>
          <button class="qf-apply">Apply</button>
          <button class="qf-dismiss">Dismiss</button>
        `;
        node.querySelector(".qf-apply").addEventListener("click", () => this.#applyQuickFix());
        node.querySelector(".qf-dismiss").addEventListener("click", () => this.#dismissQuickFix());
        return node;
      },
      getPosition: () => ({
        position: { lineNumber: line, column: model.getLineMaxColumn(line) },
        preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
      })
    };

    this.#editor.addContentWidget(widget);
    this.#editor.revealLineInCenterIfOutsideViewport(line);
    this.#activeQuickFix = { widget, line, oldText, newText, message, decorations };
    return { success: true, line, message: `Quick-fix offered on line ${line}. Waiting for student.` };
  }

  getLineScreenPos(lineNumber) {
    if (!this.#editor) return null;
    const topPos = this.#editor.getScrolledVisiblePosition({ lineNumber, column: 1 });
    if (!topPos) return null;
    const rect = this.#editor.getDomNode()?.getBoundingClientRect();
    if (!rect) return null;
    return { x: rect.left + topPos.left + 40, y: rect.top + topPos.top + 10 };
  }

  // ---- Private ----

  #applyQuickFix() {
    if (!this.#activeQuickFix) return;
    const { line, oldText, newText, message } = this.#activeQuickFix;
    const model = this.#editor.getModel();
    const lineContent = model.getLineContent(line);
    const col = lineContent.indexOf(oldText);
    if (col === -1) {
      this.#clearQuickFix();
      document.dispatchEvent(new CustomEvent("quickfix-applied", {
        detail: { line, message, error: `text no longer found on line ${line}` }
      }));
      return;
    }
    const range = new monaco.Range(line, col + 1, line, col + 1 + oldText.length);
    this.#editor.executeEdits("code-coach-quickfix", [{ range, text: newText, forceMoveMarkers: true }]);
    this.#clearQuickFix();
    document.dispatchEvent(new CustomEvent("quickfix-applied", { detail: { line, message } }));
  }

  #dismissQuickFix() {
    if (!this.#activeQuickFix) return;
    const { line, message } = this.#activeQuickFix;
    this.#clearQuickFix();
    document.dispatchEvent(new CustomEvent("quickfix-dismissed", { detail: { line, message } }));
  }

  #clearQuickFix() {
    if (!this.#activeQuickFix) return;
    this.#editor.removeContentWidget(this.#activeQuickFix.widget);
    if (this.#activeQuickFix.decorations.length) {
      this.#editor.deltaDecorations(this.#activeQuickFix.decorations, []);
    }
    this.#activeQuickFix = null;
  }

  #dismissAnnotation() {
    if (!this.#activeAnnotation) return;
    const dismissed = { ...this.#activeAnnotation };
    this.clearHighlights();
    document.dispatchEvent(new CustomEvent("annotation-dismissed", { detail: dismissed }));
  }

  #initMonaco() {
    require.config({
      paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" }
    });
    require(["vs/editor/editor.main"], () => {
      this.#editor = monaco.editor.create(document.getElementById("monaco-container"), {
        value: STARTER_CODE,
        language: "javascript",
        theme: "vs-dark",
        fontSize: 14,
        minimap: { enabled: false },
        automaticLayout: true,
        wordWrap: "on",
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        tabSize: 2,
        glyphMargin: true,
      });

      // Selection changes
      this.#editor.onDidChangeCursorSelection(() => {
        const sel = this.getSelection();
        document.dispatchEvent(new CustomEvent("selection-changed", { detail: sel }));
      });

      // Glyph margin click to dismiss annotation
      this.#editor.onMouseDown((e) => {
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && this.#activeAnnotation) {
          const clickedLine = e.target.position?.lineNumber;
          if (clickedLine && clickedLine >= this.#activeAnnotation.startLine && clickedLine <= this.#activeAnnotation.endLine) {
            this.#dismissAnnotation();
          }
        }
      });

      // Inject decoration styles
      const styleEl = document.createElement("style");
      styleEl.textContent = `
        .coach-highlight-line { background: rgba(86, 156, 214, 0.15) !important; }
        .coach-glyph { cursor: pointer !important; }
        .coach-glyph::before {
          content: '\\2715'; color: #569cd688; font-size: 12px;
          line-height: 19px; display: block; text-align: center;
        }
        .coach-glyph:hover::before { color: #f44747; }
      `;
      document.head.appendChild(styleEl);

      this.#initResolve();
    });
  }
}
customElements.define("code-editor", CodeEditor);

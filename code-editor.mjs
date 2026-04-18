// =========================================================================
// <code-editor> : Monaco editor + multi-tab + decorations + quick-fix
//
// Each tab has an associated file path and its own Monaco ITextModel.
// Tabs can be dirty (unsaved edits relative to the FileStore).
//
// Public API (called by boot.mjs):
//   openTab(path, content, language)  – open or focus a tab
//   closeTab(path)                    – close a tab (no save prompt)
//   getActiveTab()                    – { path, dirty } | null
//   listTabs()                        – [{ path, dirty, active }]
//   getValue(path?)                   – content of tab (active if omitted)
//   setValue(path, content)           – set content without marking dirty
//   getPosition()                     – {lineNumber, column}
//   getSelection()                    – { startLine, endLine, text } | null
//   getLineContent(n)                 – text of line n (active tab)
//   getLineCount()                    – total lines (active tab)
//   getCode(path)                     – numbered source for LLM context
//   editCode({ tab_path, startLine, endLine, newText })
//   highlightLines({ tab_path, startLine, endLine, message, linkUrl?, linkLabel? })
//   clearHighlights()
//   suggestFix({ tab_path, line, oldText, newText, message })
//   getLineScreenPos(lineNumber)       – {x,y} in viewport coords
//
// Events dispatched on document:
//   "tab-changed"         – detail: { path } (active tab switched)
//   "code-changed"        – detail: { path, code }
//   "selection-changed"   – detail: { startLine, endLine, text } | null
//   "annotation-dismissed"– detail: { tab_path, startLine, endLine, message }
//   "quickfix-applied"    – detail: { tab_path, line, message }
//   "quickfix-dismissed"  – detail: { tab_path, line, message }
// =========================================================================

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

class CodeEditor extends HTMLElement {
  // Monaco editor instance (single shared editor, models swap on tab switch)
  #editor = null;
  #monacoContainer = null; // direct reference to avoid getElementById races

  // Tab state: Map<path, { model, dirty }>
  #tabs = new Map();
  #activePath = null;

  // Decoration/annotation state (per active tab -- cleared on tab switch)
  #activeDecorations = [];
  #annotationStyleEl = null;
  #activeAnnotation = null;
  #activeQuickFix = null;

  // Tab bar DOM element (rendered inside this element)
  #tabBar = null;

  #initResolve = null;
  #initPromise = null;

  constructor() {
    super();
    this.#initPromise = new Promise(r => { this.#initResolve = r; });
  }

  get ready() { return this.#initPromise; }

  connectedCallback() {
    // Tab bar + Monaco container are both children of this element.
    // The element itself must fill its flex slot (see CSS in index.html).
    this.style.display = "flex";
    this.style.flexDirection = "column";
    this.style.flex = "1";
    this.style.minHeight = "0";
    this.style.overflow = "hidden";

    this.#tabBar = document.createElement("div");
    this.#tabBar.id = "tab-bar";
    this.appendChild(this.#tabBar);

    // Create Monaco container as a child instead of relying on external div
    this.#monacoContainer = document.createElement("div");
    this.#monacoContainer.id = "monaco-container";
    this.#monacoContainer.style.flex = "1";
    this.#monacoContainer.style.minHeight = "0";
    this.appendChild(this.#monacoContainer);

    this.#initMonaco();
  }

  // ---- Tab management ----

  /**
   * Open a file in a new tab (or focus it if already open).
   * @param {string} path
   * @param {string} content
   * @param {string} language  – Monaco language id
   */
  openTab(path, content, language = "plaintext") {
    if (this.#tabs.has(path)) {
      this.#switchTo(path);
      return { success: true, note: `Tab already open: ${path}` };
    }
    if (!this.#editor) return { error: "Editor not ready" };
    const model = monaco.editor.createModel(content, language);
    // Track content changes to mark dirty
    model.onDidChangeContent(() => {
      const tab = this.#tabs.get(path);
      if (tab && !tab.dirty) {
        tab.dirty = true;
        this.#renderTabBar();
      }
      if (this.#activePath === path) {
        document.dispatchEvent(new CustomEvent("code-changed", {
          detail: { path, code: model.getValue() }
        }));
      }
    });
    this.#tabs.set(path, { model, dirty: false });
    this.#switchTo(path);
    return { success: true };
  }

  closeTab(path) {
    if (!this.#tabs.has(path)) return { error: `Tab not open: ${path}` };
    const { model } = this.#tabs.get(path);
    const wasActive = this.#activePath === path;
    this.#tabs.delete(path);
    model.dispose();
    if (wasActive) {
      // Switch to last remaining tab, or clear editor
      const remaining = [...this.#tabs.keys()];
      if (remaining.length > 0) {
        this.#switchTo(remaining[remaining.length - 1]);
      } else {
        this.#activePath = null;
        this.clearHighlights();
        this.#editor?.setModel(null);
      }
    }
    this.#renderTabBar();
    return { success: true };
  }

  getActiveTab() {
    if (!this.#activePath) return null;
    const tab = this.#tabs.get(this.#activePath);
    return tab ? { path: this.#activePath, dirty: tab.dirty } : null;
  }

  listTabs() {
    return [...this.#tabs.entries()].map(([path, { dirty }]) => ({
      path,
      dirty,
      active: path === this.#activePath,
    }));
  }

  // ---- Content API ----

  getValue(path) {
    const p = path ?? this.#activePath;
    if (!p) return "";
    return this.#tabs.get(p)?.model.getValue() ?? "";
  }

  /** Set content without marking the tab dirty (used for initial load / save sync). */
  setValue(path, content) {
    const tab = this.#tabs.get(path);
    if (!tab) return { error: `Tab not open: ${path}` };
    // Temporarily suppress dirty flagging
    tab._suppressDirty = true;
    tab.model.setValue(content);
    tab.dirty = false;
    tab._suppressDirty = false;
    this.#renderTabBar();
    return { success: true };
  }

  markClean(path) {
    const tab = this.#tabs.get(path);
    if (!tab) return { error: `Tab not open: ${path}` };
    tab.dirty = false;
    this.#renderTabBar();
    return { success: true };
  }

  getPosition() { return this.#editor?.getPosition(); }
  getLineCount() {
    const tab = this.#tabs.get(this.#activePath);
    return tab?.model.getLineCount() ?? 0;
  }
  getLineContent(n) {
    const tab = this.#tabs.get(this.#activePath);
    return tab?.model.getLineContent(n) ?? "";
  }

  getSelection() {
    if (!this.#editor) return null;
    const sel = this.#editor.getSelection();
    if (!sel || sel.isEmpty()) return null;
    const model = this.#editor.getModel();
    const text = model?.getValueInRange(sel) ?? "";
    return { startLine: sel.startLineNumber, endLine: sel.endLineNumber, text };
  }

  /** Get numbered source code for LLM context. */
  getCode(path) {
    const p = path ?? this.#activePath;
    if (!p) return { error: "No tab open" };
    const tab = this.#tabs.get(p);
    if (!tab) return { error: `Tab not open: ${p}` };
    const code = tab.model.getValue();
    const numbered = code.split("\n").map((line, i) => `${i + 1}: ${line}`).join("\n");
    return {
      tab_path: p,
      code: numbered,
      lineCount: tab.model.getLineCount(),
      dirty: tab.dirty,
      note: "Line numbers are 1-indexed.",
    };
  }

  editCode({ tab_path, startLine, endLine, newText }) {
    if (!this.#editor) return { error: "Editor not ready" };
    const p = tab_path ?? this.#activePath;
    if (!p) return { error: "No tab open" };
    const tab = this.#tabs.get(p);
    if (!tab) return { error: `Tab not open: ${p}` };

    // Bring the target tab into focus so executeEdits works
    if (p !== this.#activePath) this.#switchTo(p);

    const model = tab.model;
    const totalLines = model.getLineCount();
    startLine = Math.max(1, Math.min(startLine, totalLines));
    endLine = Math.max(startLine, Math.min(endLine, totalLines));
    const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
    this.#editor.executeEdits("pair-agent", [{ range, text: newText, forceMoveMarkers: true }]);
    return { success: true, tab_path: p, linesAffected: `${startLine}-${endLine}`, newLineCount: model.getLineCount() };
  }

  highlightLines({ tab_path, startLine, endLine, message, linkUrl, linkLabel }) {
    if (!this.#editor) return { error: "Editor not ready" };
    const p = tab_path ?? this.#activePath;
    if (!p) return { error: "No tab open" };
    const tab = this.#tabs.get(p);
    if (!tab) return { error: `Tab not open: ${p}` };

    if (p !== this.#activePath) this.#switchTo(p);
    this.clearHighlights();

    const model = tab.model;
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
      .agent-inline-annotation::after {
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
          className: "agent-highlight-line",
          glyphMarginClassName: "agent-glyph",
          hoverMessage: { value: hoverMessage, isTrusted: true },
        }
      },
      {
        range: new monaco.Range(startLine, 1, startLine, model.getLineMaxColumn(startLine)),
        options: { afterContentClassName: "agent-inline-annotation" }
      }
    ]);

    this.#activeAnnotation = { tab_path: p, startLine, endLine, message };
    this.#editor.revealLineInCenterIfOutsideViewport(startLine);

    requestAnimationFrame(() => {
      const pos = this.getLineScreenPos(startLine);
      if (pos) document.dispatchEvent(new CustomEvent("particles-spawn", { detail: pos }));
    });

    return { success: true, tab_path: p, highlighted: `lines ${startLine}-${endLine}` };
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

  suggestFix({ tab_path, line, oldText, newText, message }) {
    if (!this.#editor) return { error: "Editor not ready" };
    const p = tab_path ?? this.#activePath;
    if (!p) return { error: "No tab open" };
    const tab = this.#tabs.get(p);
    if (!tab) return { error: `Tab not open: ${p}` };

    if (p !== this.#activePath) this.#switchTo(p);
    this.#clearQuickFix();

    const model = tab.model;
    const totalLines = model.getLineCount();
    line = Math.max(1, Math.min(line, totalLines));
    const lineContent = model.getLineContent(line);
    if (!lineContent.includes(oldText)) return { error: `"${oldText}" not found on line ${line} of ${p}` };

    const decorations = this.#editor.deltaDecorations([], [{
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: "agent-highlight-line" }
    }]);

    const widgetId = `agent-quickfix-${Date.now()}`;
    const widget = {
      getId: () => widgetId,
      getDomNode: () => {
        const node = document.createElement("div");
        node.className = "agent-quickfix";
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
    this.#activeQuickFix = { widget, tab_path: p, line, oldText, newText, message, decorations };
    return { success: true, tab_path: p, line, message: `Quick-fix offered on line ${line}. Waiting for user.` };
  }

  getLineScreenPos(lineNumber) {
    if (!this.#editor) return null;
    const topPos = this.#editor.getScrolledVisiblePosition({ lineNumber, column: 1 });
    if (!topPos) return null;
    const rect = this.#editor.getDomNode()?.getBoundingClientRect();
    if (!rect) return null;
    return { x: rect.left + topPos.left + 40, y: rect.top + topPos.top + 10 };
  }

  // ---- Private: tab switching ----

  #switchTo(path) {
    if (!this.#tabs.has(path)) return;
    // Clear decorations from previous tab before switching
    this.clearHighlights();
    this.#clearQuickFix();

    this.#activePath = path;
    const { model } = this.#tabs.get(path);
    this.#editor.setModel(model);
    this.#renderTabBar();
    document.dispatchEvent(new CustomEvent("tab-changed", { detail: { path } }));
  }

  // ---- Private: tab bar rendering ----

  #renderTabBar() {
    if (!this.#tabBar) return;
    this.#tabBar.innerHTML = "";
    for (const [path, { dirty }] of this.#tabs) {
      const tab = document.createElement("div");
      tab.className = "editor-tab" + (path === this.#activePath ? " active" : "");
      const label = path.split("/").pop(); // show only filename
      tab.title = path; // full path on hover
      tab.innerHTML = `<span class="tab-label">${escapeHtml(label)}${dirty ? " \u25CF" : ""}</span>`
        + `<span class="tab-close" title="Close tab">&#x2715;</span>`;
      tab.querySelector(".tab-label").addEventListener("click", () => this.#switchTo(path));
      tab.querySelector(".tab-close").addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(path);
      });
      this.#tabBar.appendChild(tab);
    }
  }

  // ---- Private: quick-fix ----

  #applyQuickFix() {
    if (!this.#activeQuickFix) return;
    const { tab_path, line, oldText, newText, message } = this.#activeQuickFix;
    const model = this.#tabs.get(tab_path)?.model;
    if (!model) { this.#clearQuickFix(); return; }
    const lineContent = model.getLineContent(line);
    const col = lineContent.indexOf(oldText);
    if (col === -1) {
      this.#clearQuickFix();
      document.dispatchEvent(new CustomEvent("quickfix-applied", {
        detail: { tab_path, line, message, error: `text no longer found on line ${line}` }
      }));
      return;
    }
    const range = new monaco.Range(line, col + 1, line, col + 1 + oldText.length);
    this.#editor.executeEdits("agent-quickfix", [{ range, text: newText, forceMoveMarkers: true }]);
    this.#clearQuickFix();
    document.dispatchEvent(new CustomEvent("quickfix-applied", { detail: { tab_path, line, message } }));
  }

  #dismissQuickFix() {
    if (!this.#activeQuickFix) return;
    const { tab_path, line, message } = this.#activeQuickFix;
    this.#clearQuickFix();
    document.dispatchEvent(new CustomEvent("quickfix-dismissed", { detail: { tab_path, line, message } }));
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

  // ---- Private: Monaco init ----

  #initMonaco() {
    require.config({
      paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" }
    });
    require(["vs/editor/editor.main"], () => {
      const createEditor = () => {
      // Replace the container element entirely so Monaco doesn't see a
      // previously-registered node and return a stale/disposed editor.
      const fresh = document.createElement("div");
      fresh.id = "monaco-container";
      fresh.style.flex = "1";
      fresh.style.minHeight = "0";
      this.#monacoContainer.replaceWith(fresh);
      this.#monacoContainer = fresh;
      this.#editor = monaco.editor.create(this.#monacoContainer, {
        model: null, // no model until first tab is opened
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
        .agent-highlight-line { background: rgba(86, 156, 214, 0.15) !important; }
        .agent-glyph { cursor: pointer !important; }
        .agent-glyph::before {
          content: '\\2715'; color: #569cd688; font-size: 12px;
          line-height: 19px; display: block; text-align: center;
        }
        .agent-glyph:hover::before { color: #f44747; }

        #tab-bar {
          display: flex; overflow-x: auto; background: #252526;
          border-bottom: 1px solid #333; flex-shrink: 0;
          scrollbar-width: none;
        }
        #tab-bar::-webkit-scrollbar { display: none; }
        .editor-tab {
          display: flex; align-items: center; gap: 4px;
          padding: 4px 12px; font-size: 12px; color: #888;
          border-right: 1px solid #333; cursor: pointer;
          white-space: nowrap; user-select: none; flex-shrink: 0;
        }
        .editor-tab:hover { background: #2d2d2d; color: #ccc; }
        .editor-tab.active { background: #1e1e1e; color: #d4d4d4; border-bottom: 1px solid #569cd6; }
        .tab-close {
          font-size: 10px; color: #666; padding: 0 2px;
          border-radius: 2px; line-height: 1;
        }
        .tab-close:hover { color: #f44747; background: #3a3a3a; }
      `;
      document.head.appendChild(styleEl);

      this.#initResolve();
      }; // end createEditor

      // The AMD loader may fire synchronously (Monaco already cached) before the
      // browser has done a layout pass. setTimeout(0) guarantees we are past the
      // current call stack and the container has nonzero dimensions.
      setTimeout(() => createEditor(), 0);
    });
  }
}
customElements.define("code-editor", CodeEditor);

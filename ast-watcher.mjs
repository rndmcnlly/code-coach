// =========================================================================
// <ast-watcher> : Tree-sitter parsing, polling, stability detection, diff
//
// Attributes: poll-ms, stability-threshold, debounce-ms
// Requires: a <code-editor> element (passed via setEditor())
// Methods:
//   async init()                – load tree-sitter WASM
//   setEditor(codeEditor)      – bind to a CodeEditor instance
//   startPolling()
//   getLastCoachedCode()       – for resetting after edits
// Events dispatched on document:
//   "ast-status"               – detail: { cls, text }
//   "code-context"             – detail: { message, hasErrors } (ready to send to agent)
// =========================================================================
class AstWatcher extends HTMLElement {
  #parser = null;
  #language = null;
  #ready = false;
  #editor = null;

  #lastCode = "";
  #lastASTSexp = "";
  #lastCoachedSexp = "";
  #lastCoachedCode = "";
  #stableCount = 0;
  #lastCoachTime = 0;
  #coachResponding = false;

  #pollMs = 1000;
  #stabilityThreshold = 2;
  #debounceMs = 4000;

  connectedCallback() {
    this.#pollMs = parseInt(this.getAttribute("poll-ms")) || 1000;
    this.#stabilityThreshold = parseInt(this.getAttribute("stability-threshold")) || 2;
    this.#debounceMs = parseInt(this.getAttribute("debounce-ms")) || 4000;

    // Listen for agent response to track timing
    document.addEventListener("agent-response", () => {
      this.#lastCoachTime = Date.now();
      this.#coachResponding = false;
    });
    document.addEventListener("agent-error", () => {
      this.#coachResponding = false;
    });
  }

  setEditor(editor) { this.#editor = editor; }
  setCoachResponding(v) { this.#coachResponding = v; }
  get lastCoachedCode() { return this.#lastCoachedCode; }

  /** Reset tracking state after an external edit (e.g. tool edit_code). */
  resetTracking() {
    if (!this.#editor) return;
    this.#lastCode = this.#editor.getValue();
    this.#stableCount = 0;
  }

  async init() {
    const Parser = window.TreeSitter;
    await Parser.init({
      locateFile(scriptName) {
        return `https://unpkg.com/web-tree-sitter@0.24.7/${scriptName}`;
      },
    });
    this.#parser = new Parser();
    this.#language = await Parser.Language.load(
      "https://unpkg.com/tree-sitter-javascript@0.23.1/tree-sitter-javascript.wasm"
    );
    this.#parser.setLanguage(this.#language);
    this.#ready = true;
    this.#setStatus("stable", "Ready");
  }

  startPolling() {
    if (!this.#editor) return;
    this.#lastCode = this.#editor.getValue();

    // Set baseline AST
    const tree = this.#parser.parse(this.#lastCode);
    if (tree) {
      this.#lastASTSexp = tree.rootNode.toString();
      this.#lastCoachedSexp = this.#lastASTSexp;
      this.#lastCoachedCode = this.#lastCode;
    }

    setInterval(() => this.#tick(), this.#pollMs);
  }

  #tick() {
    if (!this.#ready || !this.#editor) return;
    const code = this.#editor.getValue();

    if (code === this.#lastCode) {
      if (this.#stableCount < this.#stabilityThreshold) this.#stableCount++;
      if (this.#stableCount < this.#stabilityThreshold) {
        this.#setStatus("editing", `Settling... (${this.#stableCount}/${this.#stabilityThreshold})`);
      }
      if (this.#stableCount === this.#stabilityThreshold && !this.#coachResponding) {
        const tree = this.#parser.parse(code);
        if (tree) {
          const sexp = tree.rootNode.toString();
          const hasErrors = tree.rootNode.hasError;
          if (hasErrors) {
            this.#setStatus("error", "Syntax error");
            this.#maybeCoach(code, sexp, true);
          } else if (sexp !== this.#lastCoachedSexp) {
            this.#setStatus("stable", "Stable \u2014 sending to coach");
            this.#maybeCoach(code, sexp, false);
          } else if (code !== this.#lastCoachedCode) {
            this.#setStatus("stable", "Stable \u2014 text change (rename?)");
            this.#maybeCoach(code, sexp, false);
          } else {
            this.#setStatus("stable", "Stable \u2014 no new changes");
          }
          this.#lastASTSexp = sexp;
        }
      }
    } else {
      this.#lastCode = code;
      this.#stableCount = 0;
      this.#setStatus("editing", "Editing...");
    }
  }

  #maybeCoach(code, currentSexp, hasErrors) {
    const now = Date.now();
    if (now - this.#lastCoachTime < this.#debounceMs) return;
    if (this.#coachResponding) return;

    const diff = this.#computeDiff(this.#lastCoachedSexp, currentSexp);
    const isTextOnly = (diff === "No structural changes." && code !== this.#lastCoachedCode);
    if (diff === "No structural changes." && !isTextOnly && !hasErrors) return;

    this.#lastCoachedSexp = currentSexp;
    this.#lastCoachedCode = code;
    this.#coachResponding = true;

    const pos = this.#editor.getPosition();
    const cursorLine = pos ? pos.lineNumber : "unknown";
    const cursorContent = pos ? this.#editor.getLineContent(pos.lineNumber) : "";

    let message = `[Code update]\n`;
    message += `Cursor: line ${cursorLine} (content: ${cursorContent.trim()})\n`;

    if (hasErrors) {
      const tree = this.#parser.parse(code);
      const errors = [];
      const findErrors = (node) => {
        if (node.type === "ERROR" || node.isMissing) {
          errors.push(`Line ${node.startPosition.row + 1}, col ${node.startPosition.column}: ${node.type}${node.isMissing ? " (missing)" : ""}`);
        }
        for (let i = 0; i < node.childCount; i++) findErrors(node.child(i));
      };
      findErrors(tree.rootNode);
      message += `Parse status: SYNTAX ERROR\nErrors: ${errors.join("; ") || "unknown location"}\n`;
    } else {
      message += `Parse status: OK\n`;
    }

    if (isTextOnly) {
      message += `AST diff: Structure unchanged, but identifiers or literals were renamed/edited. Check naming.\n`;
    } else {
      message += `AST diff: ${diff}\n`;
    }

    const numbered = code.split("\n").map((line, i) => `${i + 1}: ${line}`).join("\n");
    message += `\nCurrent code (with 1-indexed line numbers):\n\`\`\`\n${numbered}\n\`\`\``;

    document.dispatchEvent(new CustomEvent("code-context", { detail: { message, hasErrors } }));
  }

  #computeDiff(oldSexp, newSexp) {
    if (!oldSexp) return "Initial code snapshot (no previous state to diff against).";
    if (oldSexp === newSexp) return "No structural changes.";

    const extract = (sexp) => {
      const forms = [];
      let depth = 0, start = -1;
      for (let i = 0; i < sexp.length; i++) {
        if (sexp[i] === "(") { if (depth === 1) start = i; depth++; }
        else if (sexp[i] === ")") { depth--; if (depth === 1 && start >= 0) { forms.push(sexp.slice(start, i + 1)); start = -1; } }
      }
      return forms;
    };

    const oldForms = new Set(extract(oldSexp));
    const newForms = new Set(extract(newSexp));
    const added = [...newForms].filter(f => !oldForms.has(f));
    const removed = [...oldForms].filter(f => !newForms.has(f));
    const parts = [];
    if (added.length) parts.push(`Added ${added.length} AST node(s): ${added.map(f => f.slice(0, 120)).join("; ")}`);
    if (removed.length) parts.push(`Removed ${removed.length} AST node(s): ${removed.map(f => f.slice(0, 120)).join("; ")}`);
    if (!parts.length) parts.push("Minor structural changes detected (internal modifications to existing nodes).");
    return parts.join("\n");
  }

  #setStatus(cls, text) {
    document.dispatchEvent(new CustomEvent("ast-status", { detail: { cls, text } }));
  }
}
customElements.define("ast-watcher", AstWatcher);

// =========================================================================
// AstWatcher : Tree-sitter parsing, polling, stability detection, diff
//
// Plain class (no DOM dependency). Constructed with config, wired by boot.
//
// Constructor: new AstWatcher({ pollMs, stabilityThreshold, debounceMs, lingerMs })
// Methods:
//   async init()                    – load tree-sitter WASM
//   setEditor(editor)              – bind to anything with getValue/getPosition/getLineContent
//   startPolling()
//   resetTracking()
//   setCoachResponding(bool)
//   get lastCoachedCode
// Callbacks (set by caller):
//   onStatus(cls, text)
//   onCodeContext(message, hasErrors)
//   onCursorLinger(line, lineContent) – cursor stayed on one line for lingerMs
// =========================================================================

export class AstWatcher {
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

  #pollMs;
  #stabilityThreshold;
  #debounceMs;
  #lingerMs;

  // Cursor linger tracking
  #lastCursorLine = -1;
  #cursorLingerStart = 0;
  #lastLingerLine = -1;   // last line we fired a linger for (avoid repeats)

  // Callbacks – set by the caller (boot.mjs)
  onStatus = () => {};
  onCodeContext = () => {};
  onCursorLinger = () => {};

  /**
   * @param {Object} config
   * @param {number} [config.pollMs=1000]
   * @param {number} [config.stabilityThreshold=2]
   * @param {number} [config.debounceMs=4000]
   * @param {number} [config.lingerMs=8000] – how long cursor must stay on a line
   */
  constructor({ pollMs = 1000, stabilityThreshold = 2, debounceMs = 4000, lingerMs = 8000 } = {}) {
    this.#pollMs = pollMs;
    this.#stabilityThreshold = stabilityThreshold;
    this.#debounceMs = debounceMs;
    this.#lingerMs = lingerMs;
  }

  setEditor(editor) { this.#editor = editor; }
  setCoachResponding(v) { this.#coachResponding = v; }
  get lastCoachedCode() { return this.#lastCoachedCode; }

  /** Notify that the agent finished responding (resets timing). */
  notifyResponseDone() {
    this.#lastCoachTime = Date.now();
    this.#coachResponding = false;
  }

  /** Notify that the agent errored (clears responding flag). */
  notifyResponseError() {
    this.#coachResponding = false;
  }

  /** Expose the language for query construction. */
  get language() { return this.#language; }

  /**
   * Find a node by tree-sitter query. Returns the @target capture's line range.
   * @param {string} queryStr – tree-sitter S-expression query with @target capture
   * @param {number} [matchIndex=0] – which match to use if multiple
   * @returns {{ startLine: number, endLine: number, text: string } | { error: string }}
   */
  queryNode(queryStr, matchIndex = 0) {
    if (!this.#ready || !this.#editor) return { error: "Parser not ready" };

    const code = this.#editor.getValue();
    const tree = this.#parser.parse(code);
    if (!tree) return { error: "Failed to parse code" };

    let query;
    try {
      query = this.#language.query(queryStr);
    } catch (e) {
      return { error: `Invalid query: ${e.message}` };
    }

    const matches = query.matches(tree.rootNode);
    if (matches.length === 0) return { error: "Query matched no nodes" };
    if (matchIndex >= matches.length) {
      return { error: `Only ${matches.length} match(es), requested index ${matchIndex}` };
    }

    const match = matches[matchIndex];
    const targetCapture = match.captures.find(c => c.name === "target");
    if (!targetCapture) {
      return { error: "Query has no @target capture. Add @target to the node you want to replace." };
    }

    const node = targetCapture.node;
    return {
      startLine: node.startPosition.row + 1,   // 1-indexed
      endLine: node.endPosition.row + 1,
      text: node.text,
    };
  }

  /** Reset tracking state after an external edit (e.g. edit_text, edit_node). */
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
    this.onStatus("stable", "Ready");
  }

  startPolling() {
    if (!this.#editor) return;
    this.#lastCode = this.#editor.getValue();

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
        this.onStatus("editing", `Settling... (${this.#stableCount}/${this.#stabilityThreshold})`);
      }
      if (this.#stableCount === this.#stabilityThreshold && !this.#coachResponding) {
        const tree = this.#parser.parse(code);
        if (tree) {
          const sexp = tree.rootNode.toString();
          const hasErrors = tree.rootNode.hasError;
          if (hasErrors) {
            this.onStatus("error", "Syntax error");
            this.#maybeCoach(code, sexp, true);
          } else if (sexp !== this.#lastCoachedSexp) {
            this.onStatus("stable", "Stable \u2014 sending to coach");
            this.#maybeCoach(code, sexp, false);
          } else if (code !== this.#lastCoachedCode) {
            this.onStatus("stable", "Stable \u2014 text change (rename?)");
            this.#maybeCoach(code, sexp, false);
          } else {
            this.onStatus("stable", "Stable \u2014 no new changes");
          }
          this.#lastASTSexp = sexp;
        }
      }
    } else {
      this.#lastCode = code;
      this.#stableCount = 0;
      this.#lastLingerLine = -1;   // code changed, reset linger memory
      this.onStatus("editing", "Editing...");
    }

    // Cursor linger detection (independent of code changes)
    this.#checkCursorLinger();
  }

  #checkCursorLinger() {
    if (this.#coachResponding) return;
    const pos = this.#editor.getPosition();
    if (!pos) return;
    const line = pos.lineNumber;
    const now = Date.now();

    if (line !== this.#lastCursorLine) {
      // Cursor moved to a different line
      this.#lastCursorLine = line;
      this.#cursorLingerStart = now;
    } else if (
      line !== this.#lastLingerLine &&
      now - this.#cursorLingerStart >= this.#lingerMs &&
      now - this.#lastCoachTime >= this.#debounceMs
    ) {
      // Cursor has lingered on this line long enough
      this.#lastLingerLine = line;
      const content = this.#editor.getLineContent(line);
      this.onCursorLinger(line, content);
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

    this.onCodeContext(message, hasErrors);
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
}

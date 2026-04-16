// =========================================================================
// <game-preview> : iframe sandbox, console relay, screenshot capture
//
// Methods:
//   run(code)                   – load code in iframe with Phaser 4
//   async captureScreenshot()   – returns {success, base64} or {error}
//   getConsoleSnapshot()        – recent console lines as string
//   clearConsole()
// Events dispatched on document:
//   "console-line"              – detail: { level, text }
// =========================================================================
class GamePreview extends HTMLElement {
  #iframe = null;
  #consoleArea = null;
  #consoleLines = [];
  #lastScreenshotBase64 = null;

  connectedCallback() {
    this.#iframe = document.getElementById("game-iframe");
    this.#consoleArea = document.getElementById("console-area");

    // Listen for console messages from iframe
    window.addEventListener("message", (e) => {
      if (e.data?.type === "console") this.#addConsoleLine(e.data.level, e.data.text);
    });

    // Wire up buttons
    document.getElementById("run-btn").addEventListener("click", () => this.runFromEditor());
    document.getElementById("clear-console-btn").addEventListener("click", () => this.clearConsole());
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.runFromEditor(); }
    });
  }

  /** Run using current editor code (needs editor reference set by orchestrator). */
  runFromEditor() {
    const editor = document.querySelector("code-editor");
    if (editor) {
      this.run(editor.getValue());
      document.dispatchEvent(new CustomEvent("student-run"));
    }
  }

  run(code) {
    this.clearConsole();
    this.#addConsoleLine("log", "Running...");

    const html = `<!DOCTYPE html>
<html><head>
<style>* { margin: 0; padding: 0; } body { background: #000; overflow: hidden; }</style>
<script src="https://cdn.jsdelivr.net/npm/phaser@4.0.0/dist/phaser.min.js"><\/script>
</head><body>
<script>
const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(type, attrs) {
  if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
    attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
  }
  return _origGetContext.call(this, type, attrs);
};
['log','warn','error'].forEach(level => {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    try {
      parent.postMessage({ type: 'console', level, text: args.map(a => {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
        catch { return String(a); }
      }).join(' ') }, '*');
    } catch {}
  };
});
window.onerror = (msg, src, line, col, err) => {
  parent.postMessage({ type: 'console', level: 'error',
    text: msg + (line ? ' (line ' + line + ')' : '') }, '*');
};
window.onunhandledrejection = (e) => {
  parent.postMessage({ type: 'console', level: 'error',
    text: 'Unhandled promise rejection: ' + (e.reason?.message || e.reason) }, '*');
};
<\/script>
<script>
${code}
<\/script>
</body></html>`;

    this.#iframe.srcdoc = html;
    return { success: true, message: "Preview running. Console output will appear." };
  }

  async captureScreenshot() {
    return new Promise((resolve) => {
      try {
        const win = this.#iframe.contentWindow;
        const doc = win?.document;
        if (!doc) { resolve({ error: "No preview running. Run the code first." }); return; }
        const canvas = doc.querySelector("canvas");
        if (!canvas) { resolve({ error: "No canvas found in preview. Is Phaser running?" }); return; }

        win.requestAnimationFrame(() => {
          try {
            const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
            let base64 = dataUrl.split(",")[1];
            if (!base64 || base64.length < 500) {
              const pngUrl = canvas.toDataURL("image/png");
              base64 = pngUrl.split(",")[1];
            }
            this.#lastScreenshotBase64 = base64;
            resolve({ success: true, base64, imageSize: base64.length });
          } catch (err) {
            resolve({ error: `Screenshot failed: ${err.message}` });
          }
        });
      } catch (err) {
        resolve({ error: `Screenshot failed: ${err.message}` });
      }
    });
  }

  get lastScreenshotBase64() { return this.#lastScreenshotBase64; }

  getConsoleSnapshot() {
    if (this.#consoleLines.length === 0) return "No console output.";
    return this.#consoleLines.map(l => `[${l.level}] ${l.text}`).join("\n");
  }

  clearConsole() {
    this.#consoleLines = [];
    this.#consoleArea.innerHTML = "";
  }

  #addConsoleLine(level, text) {
    this.#consoleLines.push({ level, text });
    if (this.#consoleLines.length > 50) this.#consoleLines.shift();
    const div = document.createElement("div");
    div.className = `console-line ${level}`;
    div.textContent = `[${level}] ${text}`;
    this.#consoleArea.appendChild(div);
    this.#consoleArea.scrollTop = this.#consoleArea.scrollHeight;
  }
}
customElements.define("game-preview", GamePreview);

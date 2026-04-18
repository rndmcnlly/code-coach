// =========================================================================
// <game-preview> : iframe sandbox, console relay, screenshot capture
//
// The preview runs arbitrary HTML/JS -- not Phaser-specific.
// run(html) accepts a full HTML document string.
// runCode(jsCode) wraps bare JS in a minimal HTML shell (for convenience).
//
// Screenshot strategy:
//   1. If the iframe contains a <canvas>, read it directly (fast, lossless).
//   2. Otherwise, inject html2canvas into the iframe and capture the viewport.
//
// Methods:
//   run(html)                   – load full HTML doc in iframe
//   runCode(jsCode)             – wrap JS in minimal shell and run
//   async captureScreenshot()   – returns { success, base64 } or { error }
//   getConsoleSnapshot()        – recent console lines as string
//   clearConsole()
//
// Events dispatched on document:
//   "console-line"              – detail: { level, text }
// =========================================================================

const HTML2CANVAS_CDN = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";

class GamePreview extends HTMLElement {
  #iframe = null;
  #consoleArea = null;
  #consoleLines = [];
  #lastScreenshotBase64 = null;

  connectedCallback() {
    this.#iframe = document.getElementById("game-iframe");
    this.#consoleArea = document.getElementById("console-area");

    window.addEventListener("message", (e) => {
      if (e.data?.type === "console") this.#addConsoleLine(e.data.level, e.data.text);
    });

    document.getElementById("run-btn").addEventListener("click", () => this.#runFromEditor());
    document.getElementById("clear-console-btn").addEventListener("click", () => this.clearConsole());
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.#runFromEditor(); }
    });
  }

  #runFromEditor() {
    // Get active tab content from the editor
    const editor = document.querySelector("code-editor");
    if (!editor) return;
    const activeTab = editor.getActiveTab();
    if (!activeTab) return;
    const content = editor.getValue(activeTab.path);
    const path = activeTab.path;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";

    if (ext === "html" || ext === "htm") {
      this.run(content);
    } else {
      this.runCode(content);
    }
    document.dispatchEvent(new CustomEvent("user-run", { detail: { path } }));
  }

  /** Load a full HTML document in the preview iframe. */
  run(html) {
    this.clearConsole();
    this.#addConsoleLine("log", "Running...");
    this.#iframe.srcdoc = this.#injectConsoleRelay(html);
    return { success: true, message: "Preview running." };
  }

  /**
   * Wrap bare JS in a minimal HTML shell and run it.
   * Injects Phaser 4 from CDN if the code references Phaser.
   */
  runCode(jsCode) {
    this.clearConsole();
    this.#addConsoleLine("log", "Running...");
    const needsPhaser = /\bPhaser\b/.test(jsCode);
    const phaserScript = needsPhaser
      ? `<script src="https://cdn.jsdelivr.net/npm/phaser@4.0.0/dist/phaser.min.js"><\/script>`
      : "";
    const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>* { margin: 0; padding: 0; } body { background: #1e1e1e; overflow: hidden; }</style>
${phaserScript}
</head><body>
<script>
${jsCode}
<\/script>
</body></html>`;
    this.#iframe.srcdoc = this.#injectConsoleRelay(html);
    return { success: true, message: "Preview running." };
  }

  async captureScreenshot() {
    return new Promise((resolve) => {
      try {
        const win = this.#iframe.contentWindow;
        const doc = win?.document;
        if (!doc || !doc.body) {
          resolve({ error: "No preview running. Run the code first." });
          return;
        }

        win.requestAnimationFrame(async () => {
          try {
            // Strategy 1: canvas element (fast path -- works for WebGL/canvas games)
            const canvas = doc.querySelector("canvas");
            if (canvas) {
              let dataUrl = canvas.toDataURL("image/jpeg", 0.8);
              let base64 = dataUrl.split(",")[1];
              if (!base64 || base64.length < 500) {
                const pngUrl = canvas.toDataURL("image/png");
                base64 = pngUrl.split(",")[1];
              }
              this.#lastScreenshotBase64 = base64;
              resolve({ success: true, base64, method: "canvas", imageSize: base64.length });
              return;
            }

            // Strategy 2: html2canvas for arbitrary HTML content
            const base64 = await this.#captureViaHtml2Canvas(win, doc);
            this.#lastScreenshotBase64 = base64;
            resolve({ success: true, base64, method: "html2canvas", imageSize: base64.length });
          } catch (err) {
            resolve({ error: `Screenshot failed: ${err.message}` });
          }
        });
      } catch (err) {
        resolve({ error: `Screenshot failed: ${err.message}` });
      }
    });
  }

  async #captureViaHtml2Canvas(win, doc) {
    // Inject html2canvas into the iframe if not already present
    if (!win.html2canvas) {
      await new Promise((res, rej) => {
        const s = doc.createElement("script");
        s.src = HTML2CANVAS_CDN;
        s.onload = res;
        s.onerror = () => rej(new Error("Failed to load html2canvas"));
        doc.head.appendChild(s);
      });
    }
    const canvas = await win.html2canvas(doc.body, {
      backgroundColor: "#1e1e1e",
      scale: 1,
      useCORS: true,
      logging: false,
    });
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return dataUrl.split(",")[1];
  }

  get lastScreenshotBase64() { return this.#lastScreenshotBase64; }

  getConsoleSnapshot() {
    if (this.#consoleLines.length === 0) return "No console output.";
    return this.#consoleLines.map(l => `[${l.level}] ${l.text}`).join("\n");
  }

  clearConsole() {
    this.#consoleLines = [];
    if (this.#consoleArea) this.#consoleArea.innerHTML = "";
  }

  #addConsoleLine(level, text) {
    this.#consoleLines.push({ level, text });
    if (this.#consoleLines.length > 50) this.#consoleLines.shift();
    const div = document.createElement("div");
    div.className = `console-line ${level}`;
    div.textContent = `[${level}] ${text}`;
    this.#consoleArea.appendChild(div);
    this.#consoleArea.scrollTop = this.#consoleArea.scrollHeight;
    document.dispatchEvent(new CustomEvent("console-line", { detail: { level, text } }));
  }

  /** Inject console relay + preserveDrawingBuffer patch into an HTML string. */
  #injectConsoleRelay(html) {
    const relay = `<script>
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
<\/script>`;
    // Inject after <head> open tag, or prepend if no head
    if (html.includes("<head>")) return html.replace("<head>", `<head>${relay}`);
    if (html.includes("<body>")) return html.replace("<body>", `${relay}<body>`);
    return relay + html;
  }
}
customElements.define("game-preview", GamePreview);

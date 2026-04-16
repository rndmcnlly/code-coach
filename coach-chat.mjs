// =========================================================================
// <coach-chat> : Chat log, message rendering, user input, selection context
//
// Methods:
//   addMessage(role, text)
//   addContextMessage(rawMessage, hasErrors)
//   addToolCallMessage(name, args)
// Events dispatched on document:
//   "user-send"           – detail: { message, displayText }
//   "user-screenshot"     – detail: { userMessage }
// =========================================================================
import { escapeHtml, marked } from "./utils.mjs";

class CoachChat extends HTMLElement {
  #chatLog = null;
  #userInput = null;
  #thinkingEl = null;

  connectedCallback() {
    this.#chatLog = document.getElementById("chat-log");
    this.#userInput = document.getElementById("user-input");

    const sendBtn = document.getElementById("send-btn");
    sendBtn.addEventListener("click", () => this.#handleSend());
    this.#userInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.#handleSend(); }
    });

    // Screenshot button
    document.getElementById("screenshot-btn").addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("user-screenshot", {
        detail: { userMessage: "Here's what the game looks like right now. What do you think?" }
      }));
    });

    // Selection hint
    document.addEventListener("selection-changed", (e) => {
      const hint = document.getElementById("selection-hint");
      const sel = e.detail;
      if (sel) {
        hint.textContent = sel.startLine === sel.endLine
          ? `L${sel.startLine} selected`
          : `L${sel.startLine}-${sel.endLine} selected`;
      } else {
        hint.textContent = "";
      }
    });
  }

  /** Programmatically set input text and send (used by STT). */
  sendText(text) {
    this.#userInput.value = text;
    this.#handleSend();
  }

  showThinking() {
    if (this.#thinkingEl) return;
    this.#thinkingEl = document.createElement("div");
    this.#thinkingEl.className = "msg thinking";
    this.#thinkingEl.innerHTML = `<div class="label">Coach</div><span class="dot-pulse"><span></span><span></span><span></span></span>`;
    this.#chatLog.appendChild(this.#thinkingEl);
    this.#chatLog.scrollTop = this.#chatLog.scrollHeight;
  }

  hideThinking() {
    if (!this.#thinkingEl) return;
    this.#thinkingEl.remove();
    this.#thinkingEl = null;
  }

  addMessage(role, text) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    if (role === "coach") {
      let rendered;
      try { rendered = marked.parse(text, { breaks: true, gfm: true }); }
      catch { rendered = escapeHtml(text); }
      div.innerHTML = `<div class="label">Coach</div>${rendered}`;
    } else if (role === "user") {
      div.innerHTML = `<div class="label">You</div>${escapeHtml(text)}`;
    } else {
      div.textContent = text;
    }
    this.#chatLog.appendChild(div);
    this.#chatLog.scrollTop = this.#chatLog.scrollHeight;
  }

  addContextMessage(rawMessage, hasErrors) {
    const lines = rawMessage.split("\n");
    const diffLine = lines.find(l => l.startsWith("AST diff:")) || "";
    const badge = hasErrors
      ? '<span class="ctx-badge err">ERROR</span>'
      : '<span class="ctx-badge ok">OK</span>';
    const summaryText = diffLine.replace("AST diff: ", "").slice(0, 80);

    const div = document.createElement("div");
    div.className = "msg context";
    div.innerHTML = `<details>
      <summary>${badge} ${escapeHtml(summaryText)}${summaryText.length >= 80 ? "..." : ""}</summary>
      <pre>${escapeHtml(rawMessage)}</pre>
    </details>`;
    this.#chatLog.appendChild(div);
    this.#chatLog.scrollTop = this.#chatLog.scrollHeight;
  }

  addToolCallMessage(name, args) {
    const div = document.createElement("div");
    div.className = "msg toolcall";
    const summary = Object.entries(args || {})
      .filter(([k]) => k !== "newText")
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    div.textContent = `tool: ${name}(${summary})`;
    this.#chatLog.appendChild(div);
    this.#chatLog.scrollTop = this.#chatLog.scrollHeight;
  }

  #handleSend() {
    const text = this.#userInput.value.trim();
    if (!text) return;
    this.#userInput.value = "";

    const editor = document.querySelector("code-editor");
    const sel = editor?.getSelection();
    let messageToCoach = "";
    let displayText = text;

    if (sel) {
      const numbered = sel.text.split("\n").map((line, i) => `${sel.startLine + i}: ${line}`).join("\n");
      messageToCoach = `[Student selected lines ${sel.startLine}-${sel.endLine} (1-indexed)]\n`;
      messageToCoach += `Selected code:\n\`\`\`\n${numbered}\n\`\`\`\n\n`;
      messageToCoach += `Student says: ${text}`;
      displayText = `[L${sel.startLine}-${sel.endLine}] ${text}`;
    } else {
      messageToCoach = `Student says: ${text}`;
    }

    this.addMessage("user", displayText);
    document.dispatchEvent(new CustomEvent("user-send", { detail: { message: messageToCoach, displayText } }));
  }
}
customElements.define("coach-chat", CoachChat);

// =========================================================================
// Boot Orchestrator
//
// Wires all custom elements together via events and direct method calls.
// This is the only code that knows the full component topology.
// =========================================================================

// Import all component modules (side effects: each registers its custom element)
import "./code-editor.mjs";
import "./ast-watcher.mjs";
import "./game-preview.mjs";
import "./todo-list.mjs";
import "./coach-chat.mjs";
import "./speech-io.mjs";
import "./coach-agent.mjs";
import "./effects.mjs";

import { SYSTEM_PROMPT } from "./system-prompt.mjs";

async function boot() {
  // Grab component references
  const agent     = document.querySelector("coach-agent");
  const editor    = document.querySelector("code-editor");
  const watcher   = document.querySelector("ast-watcher");
  const preview   = document.querySelector("game-preview");
  const todoList  = document.querySelector("todo-list");
  const chat      = document.querySelector("coach-chat");
  const speech    = document.querySelector("speech-io");

  chat.addMessage("system", "Loading editor and language parser...");

  // Init Monaco and tree-sitter in parallel
  await Promise.all([editor.ready, watcher.init()]);

  // Wire watcher to editor
  watcher.setEditor(editor);

  // Show auth status
  const hasKey = !!localStorage.getItem("BAYLEAF_API_KEY");
  if (hasKey) {
    chat.addMessage("system", "Editor ready. Connecting to coach (BayLeaf API key)...");
  } else {
    chat.addMessage("system", "Editor ready. Connecting to coach (campus network, no key)...");
    chat.addMessage("system", "Off campus? Run in console: localStorage.setItem('BAYLEAF_API_KEY', 'sk-bayleaf-...')  — get a free key at api.bayleaf.dev");
  }

  // AST status indicator
  const astStatus = document.getElementById("ast-status");
  document.addEventListener("ast-status", (e) => {
    astStatus.className = e.detail.cls;
    astStatus.textContent = e.detail.text;
  });

  // ---- Tool dispatch ----
  // Maps tool names to handler functions. Each returns a result object.
  const toolHandlers = {
    edit_code: (args) => {
      const result = editor.editCode(args);
      watcher.resetTracking();
      return result;
    },
    highlight_lines: (args) => editor.highlightLines(args),
    clear_highlights: () => editor.clearHighlights(),
    get_code: () => editor.getCode(),
    suggest_fix: (args) => editor.suggestFix(args),
    add_todo: (args) => todoList.addTodo(args),
    complete_todo: (args) => todoList.completeTodo(args),
    remove_todo: (args) => todoList.removeTodo(args),
    run_preview: () => {
      const result = preview.run(editor.getValue());
      requestAnimationFrame(() => {
        const btn = document.getElementById("run-btn");
        if (btn) {
          const rect = btn.getBoundingClientRect();
          document.dispatchEvent(new CustomEvent("particles-spawn", {
            detail: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, count: 16 }
          }));
        }
      });
      return result;
    },
    screenshot_preview: async () => {
      const result = await preview.captureScreenshot();
      if (result.error) return result;
      // Send image + console as follow-up so the model sees both
      setTimeout(async () => {
        const base64 = preview.lastScreenshotBase64;
        if (base64) {
          let caption = "[Screenshot from your screenshot_preview tool. Describe exactly what you see: colors, shapes, positions.]";
          const consoleSnap = preview.getConsoleSnapshot();
          if (consoleSnap !== "No console output.") {
            caption += `\n\nRecent console output:\n${consoleSnap}`;
          }
          await sendToAgent([
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: "text", text: caption }
          ]);
        }
      }, 100);
      return { success: true, note: "Screenshot captured. You will receive the image momentarily." };
    },
  };

  // Handle tool calls from the agent
  document.addEventListener("agent-tool-calls", async (e) => {
    const { calls, resolve } = e.detail;
    const results = [];
    for (const call of calls) {
      chat.addToolCallMessage(call.name, call.arguments);
      let result;
      try {
        const handler = toolHandlers[call.name];
        if (!handler) throw new Error(`Unknown tool: ${call.name}`);
        result = await handler(call.arguments);
      } catch (err) {
        result = { error: err.message };
      }
      results.push({
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
    resolve(results);
  });

  // ---- Thinking indicator ----
  const coachStatus = document.getElementById("coach-status");
  function showThinking() {
    coachStatus.textContent = "Coach thinking\u2026";
    coachStatus.className = "thinking";
    chat.showThinking();
  }
  function hideThinking() {
    coachStatus.textContent = "";
    coachStatus.className = "";
    chat.hideThinking();
  }

  // Handle agent text responses
  document.addEventListener("agent-response", (e) => {
    hideThinking();
    chat.addMessage("coach", e.detail.text);
    document.dispatchEvent(new CustomEvent("speak", { detail: { text: e.detail.text } }));
  });

  document.addEventListener("agent-error", (e) => {
    hideThinking();
    chat.addMessage("system", `Coach error: ${e.detail.error}`);
  });

  // ---- Send helpers ----
  async function sendToAgent(content) {
    showThinking();
    watcher.setCoachResponding(true);
    await agent.send(content);
    // responding flag cleared by watcher listening to agent-response / agent-error
  }

  // Code context from AST watcher (automatic updates)
  document.addEventListener("code-context", async (e) => {
    const { message, hasErrors } = e.detail;

    // Append todo state
    let fullMessage = message;
    if (todoList.todos.length > 0) {
      fullMessage += `\n\nTodo list:\n${todoList.summary()}`;
    }
    const consoleSnap = preview.getConsoleSnapshot();
    if (consoleSnap !== "No console output.") {
      fullMessage += `\n\nRecent console output:\n${consoleSnap}`;
    }

    chat.addContextMessage(fullMessage, hasErrors);
    await sendToAgent(fullMessage);
  });

  // Student manually ran the preview (Run button or Ctrl+Enter)
  document.addEventListener("student-run", () => {
    chat.addMessage("system", "You ran the preview.");
    // Wait for the iframe to produce console output, then notify the agent
    setTimeout(async () => {
      const consoleSnap = preview.getConsoleSnapshot();
      await sendToAgent(`[Student ran the preview manually]\n\nConsole output:\n${consoleSnap}`);
    }, 1500);
  });

  // User text input
  document.addEventListener("user-send", async (e) => {
    await sendToAgent(e.detail.message);
  });

  // User screenshot button (bundles console output alongside the image)
  document.addEventListener("user-screenshot", async (e) => {
    const result = await preview.captureScreenshot();
    if (result.error) { chat.addMessage("system", result.error); return; }
    const base64 = preview.lastScreenshotBase64;
    const userMsg = e.detail.userMessage;
    chat.addMessage("user", userMsg || "[Sent screenshot]");
    let caption = userMsg || "[Screenshot of the game preview. Describe exactly what you see: colors, shapes, positions.]";
    const consoleSnap = preview.getConsoleSnapshot();
    if (consoleSnap !== "No console output.") {
      caption += `\n\nRecent console output:\n${consoleSnap}`;
    }
    await sendToAgent([
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
      { type: "text", text: caption }
    ]);
  });

  // Share logs button: send console output to agent on demand
  document.getElementById("share-logs-btn").addEventListener("click", async () => {
    const consoleSnap = preview.getConsoleSnapshot();
    if (consoleSnap === "No console output.") {
      chat.addMessage("system", "No console output to share.");
      return;
    }
    chat.addMessage("user", "[Shared console logs]");
    await sendToAgent(`[Student shared console logs]\n\n${consoleSnap}`);
  });

  // Annotation dismissed
  document.addEventListener("annotation-dismissed", async (e) => {
    const d = e.detail;
    chat.addMessage("system", `Dismissed annotation on L${d.startLine}\u2013${d.endLine}.`);
    await sendToAgent(`[The student dismissed your annotation on lines ${d.startLine}-${d.endLine}: "${d.message}"]`);
  });

  // Quick-fix outcomes
  document.addEventListener("quickfix-applied", async (e) => {
    const d = e.detail;
    if (d.error) {
      chat.addMessage("system", `Quick-fix failed: ${d.error}`);
      await sendToAgent(`[Quick-fix "${d.message}" could not be applied: ${d.error}]`);
    } else {
      chat.addMessage("system", `Applied quick-fix on L${d.line}: ${d.message}`);
      watcher.resetTracking();
      await sendToAgent(`[Student applied quick-fix on line ${d.line}: "${d.message}"]`);
    }
  });
  document.addEventListener("quickfix-dismissed", async (e) => {
    chat.addMessage("system", `Dismissed quick-fix on L${e.detail.line}.`);
    await sendToAgent(`[Student dismissed quick-fix on line ${e.detail.line}: "${e.detail.message}"]`);
  });

  // STT transcript -> chat input
  document.addEventListener("transcript", (e) => {
    chat.sendText(e.detail.text);
  });

  // ---- Initialize agent and start ----
  agent.setSystemPrompt(SYSTEM_PROMPT);

  // Start polling and send first turn
  watcher.startPolling();
  await sendToAgent("The student has just opened the editor. Use get_code to see what they have, then say hi briefly.");
}

boot().catch((err) => {
  console.error("Boot failed:", err);
  const chat = document.querySelector("coach-chat");
  if (chat) chat.addMessage("system", `Failed to initialize: ${err.message}`);
});

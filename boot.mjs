// =========================================================================
// Boot Orchestrator
//
// Wires all components together. Custom elements are queried from the DOM;
// plain modules are imported and constructed here with explicit dependencies.
// This is the only code that knows the full component topology.
// =========================================================================

// Custom elements (side-effect imports: each registers its element)
import "./code-editor.mjs";
import "./game-preview.mjs";
import "./todo-list.mjs";
import "./coach-chat.mjs";
import "./speech-io.mjs";

// Plain modules (explicit construction)
import { CoachAgent } from "./coach-agent.mjs";
import { AstWatcher } from "./ast-watcher.mjs";
import { SfxEngine, spawnParticles } from "./effects.mjs";
import { SYSTEM_PROMPT } from "./system-prompt.mjs";

async function boot() {
  // ---- Custom elements (still DOM-resident) ----
  const editor    = document.querySelector("code-editor");
  const preview   = document.querySelector("game-preview");
  const todoList  = document.querySelector("todo-list");
  const chat      = document.querySelector("coach-chat");
  const speech    = document.querySelector("speech-io");

  // ---- Plain modules ----
  const sfx = new SfxEngine();

  const hasKey = !!localStorage.getItem("BAYLEAF_API_KEY");
  const agent = new CoachAgent({
    apiBase: "https://api.bayleaf.dev/v1",
    model: "qwen/qwen3.5-35b-a3b",
    apiKey: localStorage.getItem("BAYLEAF_API_KEY") || "",
  });

  const watcher = new AstWatcher({
    pollMs: 1000,
    stabilityThreshold: 2,
    debounceMs: 4000,
  });

  // ---- Wire SFX button ----
  const sfxBtn = document.getElementById("sfx-btn");
  sfxBtn.textContent = `SFX: ${sfx.enabled ? "On" : "Off"}`;
  sfxBtn.classList.toggle("active", sfx.enabled);
  sfxBtn.addEventListener("click", () => {
    sfx.enabled = !sfx.enabled;
    sfxBtn.textContent = `SFX: ${sfx.enabled ? "On" : "Off"}`;
    sfxBtn.classList.toggle("active", sfx.enabled);
  });

  // ---- Init ----
  chat.addMessage("system", "Loading editor and language parser...");
  await Promise.all([editor.ready, watcher.init()]);
  watcher.setEditor(editor);

  if (hasKey) {
    chat.addMessage("system", "Editor ready. Connecting to coach (BayLeaf API key)...");
  } else {
    chat.addMessage("system", "Editor ready. Connecting to coach (campus network, no key)...");
    chat.addMessage("system", "Off campus? Run in console: localStorage.setItem('BAYLEAF_API_KEY', 'sk-bayleaf-...')  \u2014 get a free key at api.bayleaf.dev");
  }

  // ---- AST status indicator ----
  const astStatus = document.getElementById("ast-status");
  watcher.onStatus = (cls, text) => {
    astStatus.className = cls;
    astStatus.textContent = text;
  };

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

  // ---- Tool dispatch ----
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
    add_todo: (args) => {
      sfx.play("add");
      return todoList.addTodo(args);
    },
    complete_todo: (args) => {
      const result = todoList.completeTodo(args);
      if (result.success) sfx.play("complete");
      return result;
    },
    remove_todo: (args) => todoList.removeTodo(args),
    run_preview: () => {
      const result = preview.run(editor.getValue());
      requestAnimationFrame(() => {
        const btn = document.getElementById("run-btn");
        if (btn) {
          const rect = btn.getBoundingClientRect();
          spawnParticles(rect.left + rect.width / 2, rect.top + rect.height / 2, 16);
        }
      });
      return result;
    },
    screenshot_preview: async () => {
      const result = await preview.captureScreenshot();
      if (result.error) return result;
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

  async function handleToolCalls(calls) {
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
    return results;
  }

  // ---- Send helpers ----
  async function sendToAgent(content) {
    showThinking();
    watcher.setCoachResponding(true);
    await agent.send(content, {
      onToolCalls: handleToolCalls,
      onResponse: (text) => {
        hideThinking();
        watcher.notifyResponseDone();
        chat.addMessage("coach", text);
        document.dispatchEvent(new CustomEvent("speak", { detail: { text } }));
      },
      onError: (error) => {
        hideThinking();
        watcher.notifyResponseError();
        chat.addMessage("system", `Coach error: ${error}`);
      },
    });
  }

  // ---- Watcher -> Agent ----
  watcher.onCodeContext = async (message, hasErrors) => {
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
  };

  // ---- Student manually ran the preview ----
  document.addEventListener("student-run", () => {
    chat.addMessage("system", "You ran the preview.");
    setTimeout(async () => {
      const consoleSnap = preview.getConsoleSnapshot();
      await sendToAgent(`[Student ran the preview manually]\n\nConsole output:\n${consoleSnap}`);
    }, 1500);
  });

  // ---- User text input ----
  document.addEventListener("user-send", async (e) => {
    await sendToAgent(e.detail.message);
  });

  // ---- User screenshot button ----
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

  // ---- Share logs ----
  document.getElementById("share-logs-btn").addEventListener("click", async () => {
    const consoleSnap = preview.getConsoleSnapshot();
    if (consoleSnap === "No console output.") {
      chat.addMessage("system", "No console output to share.");
      return;
    }
    chat.addMessage("user", "[Shared console logs]");
    await sendToAgent(`[Student shared console logs]\n\n${consoleSnap}`);
  });

  // ---- Annotation dismissed ----
  document.addEventListener("annotation-dismissed", async (e) => {
    const d = e.detail;
    chat.addMessage("system", `Dismissed annotation on L${d.startLine}\u2013${d.endLine}.`);
    await sendToAgent(`[The student dismissed your annotation on lines ${d.startLine}-${d.endLine}: "${d.message}"]`);
  });

  // ---- Quick-fix outcomes ----
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

  // ---- STT transcript -> chat input ----
  document.addEventListener("transcript", (e) => {
    chat.sendText(e.detail.text);
  });

  // ---- Particles from editor annotations ----
  document.addEventListener("particles-spawn", (e) => {
    spawnParticles(e.detail.x, e.detail.y, e.detail.count || 12);
  });

  // ---- Initialize agent and start ----
  agent.setSystemPrompt(SYSTEM_PROMPT);
  watcher.startPolling();
  await sendToAgent("The student has just opened the editor. Use get_code to see what they have, then say hi briefly.");
}

boot().catch((err) => {
  console.error("Boot failed:", err);
  const chat = document.querySelector("coach-chat");
  if (chat) chat.addMessage("system", `Failed to initialize: ${err.message}`);
});

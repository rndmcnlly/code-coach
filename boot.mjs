// =========================================================================
// Boot Orchestrator
//
// Wires all components together. Custom elements are queried from the DOM;
// plain modules are imported and constructed here with explicit dependencies.
// This is the only code that knows the full component topology.
// =========================================================================

// Custom elements (side-effect imports: each registers its element)
import "./blackboard.mjs";
import "./code-editor.mjs";
import "./file-browser.mjs";
import "./game-preview.mjs";
import "./todo-list.mjs";
import "./coach-chat.mjs";
import "./speech-io.mjs";

// Plain modules (explicit construction)
import { PairAgent } from "./coach-agent.mjs";
import { AstWatcher } from "./ast-watcher.mjs";
import { SfxEngine, spawnParticles } from "./effects.mjs";
import { buildSystemPrompt, PERSONAS } from "./system-prompt.mjs";
import { makeDefaultMemoryStore, LocalDirectoryStore, detectLanguage } from "./file-store.mjs";

async function boot() {
  // ---- Custom elements ----
  const editor      = document.querySelector("code-editor");
  const blackboard  = document.querySelector("black-board");
  const fileBrowser = document.querySelector("file-browser");
  const preview     = document.querySelector("game-preview");
  const todoList    = document.querySelector("todo-list");
  const chat        = document.querySelector("coach-chat");
  const speech      = document.querySelector("speech-io");

  // ---- FileStore (start with in-memory default project) ----
  let store = makeDefaultMemoryStore();

  // ---- Plain modules ----
  const sfx = new SfxEngine();

  const agent = new PairAgent({
    apiBase: "https://api.bayleaf.dev/v1",
    model: "qwen/qwen3.5-35b-a3b",
    apiKey: localStorage.getItem("BAYLEAF_API_KEY") || "",
  });

  const watcher = new AstWatcher({
    pollMs: 1000,
    stabilityThreshold: 2,
    debounceMs: 4000,
    lingerMs: 8000,
  });

  // ---- File browser wiring ----
  fileBrowser.setStore(store);

  document.addEventListener("file-open", async (e) => {
    const { path } = e.detail;
    const result = await openTabFromStore(path);
    if (result.error) { chat.addMessage("system", result.error); return; }
    fileBrowser.setActivePath(path);
    await sendToAgent(`[User opened file: ${path}]`);
  });

  document.addEventListener("tab-changed", (e) => {
    fileBrowser.setActivePath(e.detail.path);
    watcher.resetTracking();
  });

  document.addEventListener("file-browser-toggle", (e) => {
    sendToAgent(`[User ${e.detail.visible ? "expanded" : "collapsed"} the file browser]`);
  });

  // ---- Panel visibility manager ----
  const PANELS = {
    files:   { el: () => document.querySelector("file-browser"),  label: "Files" },
    tasks:   { el: () => document.getElementById("todo-pane"),    label: "Tasks" },
    log:     { el: () => document.getElementById("agent-pane"),   label: "Log" },
    preview: { el: () => document.getElementById("preview-area"), label: "Preview" },
  };

  function getPanelState() {
    const state = {};
    for (const [id, { el, label }] of Object.entries(PANELS)) {
      state[id] = { label, visible: !el().classList.contains("collapsed") };
    }
    return state;
  }

  function setPanelVisible(panel, visible) {
    const p = PANELS[panel];
    if (!p) return { error: `Unknown panel: ${panel}` };
    const el = p.el();
    const wasVisible = !el.classList.contains("collapsed");
    if (visible === wasVisible) return { success: true, panel, visible, note: "no change" };
    el.classList.toggle("collapsed", !visible);
    // Sync label arrows
    if (panel === "preview") {
      const lbl = document.getElementById("preview-label");
      if (lbl) lbl.innerHTML = visible ? "Preview &#x25BC;" : "Preview &#x25B2;";
    }
    const toggle = el.querySelector?.(".panel-toggle");
    if (toggle) toggle.style.transform = visible ? "" : "rotate(180deg)";
    return { success: true, panel, visible };
  }

  // Wire collapse toggles (inline script removed from index.html; boot owns this)
  function wireCollapseToggle(headerId, panelId) {
    document.getElementById(headerId).addEventListener("click", () => {
      const el = document.getElementById(panelId);
      el.classList.toggle("collapsed");
      const nowVisible = !el.classList.contains("collapsed");
      const label = PANELS[Object.keys(PANELS).find(k => PANELS[k].el() === el)]?.label ?? panelId;
      if (panelId === "preview-area") {
        const lbl = document.getElementById("preview-label");
        if (lbl) lbl.innerHTML = nowVisible ? "Preview &#x25BC;" : "Preview &#x25B2;";
      }
      if (panelId !== "agent-pane") {
        chat.addMessage("system", `${label} ${nowVisible ? "expanded" : "collapsed"}.`);
      }
      sendToAgent(`[User ${nowVisible ? "expanded" : "collapsed"} the ${label} panel]`);
    });
  }
  wireCollapseToggle("todo-header",  "todo-pane");
  wireCollapseToggle("agent-header", "agent-pane");
  wireCollapseToggle("preview-label", "preview-area");

  // ---- Persona selector ----
  const personaSelect = document.getElementById("persona-select");
  const agentsMdCheck = document.getElementById("agents-md-check");

  // Populate persona dropdown from PERSONAS
  for (const [key, { label }] of Object.entries(PERSONAS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    if (key === "pair-programmer") opt.selected = true;
    personaSelect.appendChild(opt);
  }

  function getCurrentSystemPrompt() {
    return buildSystemPrompt({
      preset: personaSelect.value,
      respectAgentsMd: agentsMdCheck.checked,
    });
  }

  // ---- Open Directory button ----
  document.getElementById("open-dir-btn").addEventListener("click", async () => {
    const newStore = await LocalDirectoryStore.pick();
    if (!newStore) return; // user cancelled
    store = newStore;
    fileBrowser.setStore(store);
    chat.addMessage("system", `Opened directory: ${newStore.name}`);
    // Close all tabs and reload from new store
    for (const { path } of editor.listTabs()) editor.closeTab(path);
    // Let the agent discover the new project
    await sendToAgent(`[User opened a local directory: "${newStore.name}". Call list_files to explore it, then open relevant files.]`);
  });

  // ---- SFX button ----
  const sfxBtn = document.getElementById("sfx-btn");
  sfxBtn.textContent = `SFX: ${sfx.enabled ? "On" : "Off"}`;
  sfxBtn.classList.toggle("active", sfx.enabled);
  sfxBtn.addEventListener("click", () => {
    sfx.enabled = !sfx.enabled;
    sfxBtn.textContent = `SFX: ${sfx.enabled ? "On" : "Off"}`;
    sfxBtn.classList.toggle("active", sfx.enabled);
  });

  // ---- Init editor + watcher ----
  chat.addMessage("system", "Loading editor and language parser...");
  await Promise.all([editor.ready, watcher.init()]);
  watcher.setEditor(editor);

  const hasKey = !!localStorage.getItem("BAYLEAF_API_KEY");
  if (hasKey) {
    chat.addMessage("system", "Editor ready. Connecting to agent (BayLeaf API key)...");
  } else {
    chat.addMessage("system", "Editor ready. Connecting to agent (campus network, no key)...");
    chat.addMessage("system", "Off campus? Run in console: localStorage.setItem('BAYLEAF_API_KEY', 'sk-bayleaf-...')  \u2014 get a free key at api.bayleaf.dev");
  }

  // ---- Blackboard quiescence ----
  blackboard.onQuiesce = async (markdown) => {
    chat.addMessage("system", "Blackboard updated.");
    await sendToAgent(`[User updated the blackboard]\n\nBlackboard content:\n${markdown}`);
  };

  // ---- AST status indicator ----
  const astStatus = document.getElementById("ast-status");
  watcher.onStatus = (cls, text) => {
    astStatus.className = cls;
    astStatus.textContent = text;
  };

  // ---- Thinking indicator ----
  const agentStatus = document.getElementById("agent-status");
  function showThinking() {
    agentStatus.textContent = "Agent thinking\u2026";
    agentStatus.className = "thinking";
    chat.showThinking();
  }
  function hideThinking() {
    agentStatus.textContent = "";
    agentStatus.className = "";
    chat.hideThinking();
  }

  // ---- FileStore helpers used by tool handlers ----

  async function storeReadFile(path) {
    return await store.readFile(path);
  }

  async function storeWriteFile(path, content) {
    await store.writeFile(path, content);
    // If this file is open in a tab, sync the tab content without marking dirty
    const tabs = editor.listTabs();
    if (tabs.find(t => t.path === path)) {
      editor.setValue(path, content);
    }
  }

  async function openTabFromStore(path) {
    // If already open, just switch to it
    if (editor.listTabs().find(t => t.path === path)) {
      editor.openTab(path, "", detectLanguage(path)); // openTab will see it's already open
      return { success: true, note: `Tab already open: ${path}` };
    }
    try {
      const content = await store.readFile(path);
      const lang = detectLanguage(path);
      editor.openTab(path, content, lang);
      return { success: true, path, language: lang };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function saveTabToStore(path) {
    const tab = editor.listTabs().find(t => t.path === path);
    if (!tab) return { error: `Tab not open: ${path}` };
    const content = editor.getValue(path);
    await store.writeFile(path, content);
    editor.markClean(path);
    return { success: true, path };
  }

  // ---- Tool dispatch ----
  const toolHandlers = {

    // FileStore tools
    list_files: async () => {
      const files = await store.listFiles();
      return { files: files.map(f => f.path), count: files.length, store: store.name };
    },

    read_file: async ({ path }) => {
      try {
        const content = await storeReadFile(path);
        return { path, content };
      } catch (err) {
        return { error: err.message };
      }
    },

    write_file: async ({ path, content }) => {
      try {
        await storeWriteFile(path, content);
        fileBrowser.refresh();
        return { success: true, path };
      } catch (err) {
        return { error: err.message };
      }
    },

    // Tab tools
    list_tabs: () => {
      const tabs = editor.listTabs();
      return { tabs, count: tabs.length };
    },

    open_tab: async ({ path }) => {
      return await openTabFromStore(path);
    },

    close_tab: ({ tab_path }) => {
      return editor.closeTab(tab_path);
    },

    save_file: async ({ tab_path }) => {
      return await saveTabToStore(tab_path);
    },

    // Code editing tools (operate on open tabs)
    get_code: ({ tab_path }) => {
      return editor.getCode(tab_path);
    },

    edit_text: async (args) => {
      const result = editor.editCode(args);
      if (result.success) {
        watcher.resetTracking();
        if (args.autosave !== false) {
          await saveTabToStore(args.tab_path);
        }
      }
      return result;
    },

    edit_node: async (args) => {
      const found = watcher.queryNode(args.query, args.index || 0);
      if (found.error) return found;
      const result = editor.editCode({
        tab_path: args.tab_path,
        startLine: found.startLine,
        endLine: found.endLine,
        newText: args.newText,
      });
      if (result.success) {
        watcher.resetTracking();
        if (args.autosave !== false) {
          await saveTabToStore(args.tab_path);
        }
      }
      return result;
    },

    // Annotation tools
    highlight_lines: (args) => editor.highlightLines(args),

    highlight_node: (args) => {
      const found = watcher.queryNode(args.query, args.index || 0);
      if (found.error) return found;
      return editor.highlightLines({
        tab_path: args.tab_path,
        startLine: found.startLine,
        endLine: found.endLine,
        message: args.message,
        linkUrl: args.linkUrl,
        linkLabel: args.linkLabel,
      });
    },

    clear_highlights: () => editor.clearHighlights(),

    suggest_fix: (args) => editor.suggestFix(args),

    // Preview tools
    run_preview: () => {
      // game-preview reads the active tab itself via the editor element
      const activeTab = editor.getActiveTab();
      if (!activeTab) return { error: "No tab is open to run." };
      const content = editor.getValue(activeTab.path);
      const ext = activeTab.path.split(".").pop()?.toLowerCase() ?? "";
      let result;
      if (ext === "html" || ext === "htm") {
        result = preview.run(content);
      } else {
        result = preview.runCode(content);
      }
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
          const method = result.method === "html2canvas" ? "html2canvas (full viewport)" : "canvas element";
          let caption = `[Screenshot via ${method}. Describe exactly what you see: layout, colors, shapes, text.]`;
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

    // Blackboard tools
    read_blackboard: () => {
      const md = blackboard.getContent();
      return { content: md || "(empty)", length: md.length };
    },
    write_blackboard: ({ content, mode = "replace" }) => {
      if (mode === "append") {
        blackboard.appendContent(content);
      } else {
        blackboard.setContent(content);
      }
      return { success: true, mode };
    },

    // UI panel tools
    get_ui_state: () => ({ panels: getPanelState() }),
    set_panel_visible: ({ panel, visible }) => {
      const result = setPanelVisible(panel, visible);
      if (result.success && result.note !== "no change") {
        chat.addMessage("system", `Agent ${visible ? "expanded" : "collapsed"} ${PANELS[panel]?.label ?? panel}.`);
      }
      return result;
    },

    // Todo tools
    add_todo: (args) => {
      sfx.play("add");
      return todoList.addTodo(args);
    },
    complete_todo: (args) => {
      const result = todoList.completeTodo(args);
      if (result.success) sfx.play("complete");
      return result;
    },
    uncomplete_todo: (args) => todoList.uncompleteTodo(args),
    remove_todo: (args) => todoList.removeTodo(args),
    edit_todo: (args) => todoList.editTodo(args),
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
        chat.addMessage("agent", text);
        document.dispatchEvent(new CustomEvent("speak", { detail: { text } }));
      },
      onError: (error) => {
        hideThinking();
        watcher.notifyResponseError();
        chat.addMessage("system", `Agent error: ${error}`);
      },
    });
  }

  // ---- AST watcher -> agent ----
  watcher.onCursorLinger = async (line, lineContent) => {
    const activeTab = editor.getActiveTab();
    if (!activeTab) return;
    const code = editor.getValue(activeTab.path);
    const numbered = code.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
    const message = `[User's cursor has been lingering on line ${line} for a while in ${activeTab.path}]\n`
      + `Line content: ${lineContent.trim()}\n`
      + `\nThis may indicate they are stuck, confused, or studying this section. `
      + `If appropriate, offer a brief observation or ask if they need help.\n`
      + `\nCurrent file (${activeTab.path}):\n\`\`\`\n${numbered}\n\`\`\``;
    await sendToAgent(message);
  };

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

  // ---- User ran the preview ----
  document.addEventListener("user-run", (e) => {
    const path = e.detail?.path ?? "unknown";
    chat.addMessage("system", `You ran the preview (${path}).`);
    setTimeout(async () => {
      const consoleSnap = preview.getConsoleSnapshot();
      await sendToAgent(`[User ran the preview for ${path}]\n\nConsole output:\n${consoleSnap}`);
    }, 1500);
  });

  // ---- Tab changed ----
  document.addEventListener("tab-changed", (e) => {
    const { path } = e.detail;
    watcher.resetTracking();
    chat.addMessage("system", `Switched to: ${path}`);
  });

  // ---- User text input ----
  document.addEventListener("user-send", async (e) => {
    await sendToAgent(e.detail.message);
  });

  // ---- User screenshot ----
  document.addEventListener("user-screenshot", async (e) => {
    const result = await preview.captureScreenshot();
    if (result.error) { chat.addMessage("system", result.error); return; }
    const base64 = preview.lastScreenshotBase64;
    const userMsg = e.detail.userMessage;
    chat.addMessage("user", userMsg || "[Sent screenshot]");
    const method = result.method === "html2canvas" ? "html2canvas (full viewport)" : "canvas element";
    let caption = userMsg || `[Screenshot via ${method}. Describe exactly what you see.]`;
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
    await sendToAgent(`[User shared console logs]\n\n${consoleSnap}`);
  });

  // ---- Annotation dismissed ----
  document.addEventListener("annotation-dismissed", async (e) => {
    const d = e.detail;
    chat.addMessage("system", `Dismissed annotation on ${d.tab_path} L${d.startLine}\u2013${d.endLine}.`);
    await sendToAgent(`[User dismissed annotation on ${d.tab_path} lines ${d.startLine}-${d.endLine}: "${d.message}"]`);
  });

  // ---- Quick-fix outcomes ----
  document.addEventListener("quickfix-applied", async (e) => {
    const d = e.detail;
    if (d.error) {
      chat.addMessage("system", `Quick-fix failed: ${d.error}`);
      await sendToAgent(`[Quick-fix "${d.message}" could not be applied: ${d.error}]`);
    } else {
      chat.addMessage("system", `Applied quick-fix on ${d.tab_path} L${d.line}: ${d.message}`);
      watcher.resetTracking();
      // Autosave the tab after a user-applied quick-fix
      if (d.tab_path) await saveTabToStore(d.tab_path);
      await sendToAgent(`[User applied quick-fix on ${d.tab_path} line ${d.line}: "${d.message}"]`);
    }
  });

  document.addEventListener("quickfix-dismissed", async (e) => {
    chat.addMessage("system", `Dismissed quick-fix on L${e.detail.line}.`);
    await sendToAgent(`[User dismissed quick-fix on ${e.detail.tab_path} line ${e.detail.line}: "${e.detail.message}"]`);
  });

  // ---- User todo interactions ----
  document.addEventListener("user-todo-add", async (e) => {
    sfx.play("add");
    chat.addMessage("system", `You added: ${e.detail.text}`);
    await sendToAgent(`[User added todo: "${e.detail.text}"]\n\nTodo list:\n${todoList.summary()}`);
  });

  document.addEventListener("user-todo-toggle", async (e) => {
    const { text, done } = e.detail;
    const action = done ? "completed" : "uncompleted";
    chat.addMessage("system", `You ${action}: ${text}`);
    if (done) sfx.play("complete");
    await sendToAgent(`[User ${action} todo: "${text}"]\n\nTodo list:\n${todoList.summary()}`);
  });

  document.addEventListener("user-todo-remove", async (e) => {
    chat.addMessage("system", `Removed: ${e.detail.text}`);
    await sendToAgent(`[User removed todo: "${e.detail.text}"]\n\nTodo list:\n${todoList.summary()}`);
  });

  document.addEventListener("user-todo-edit", async (e) => {
    const { oldText, newText } = e.detail;
    chat.addMessage("system", `Edited: "${oldText}" \u2192 "${newText}"`);
    await sendToAgent(`[User edited todo: "${oldText}" -> "${newText}"]\n\nTodo list:\n${todoList.summary()}`);
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
  agent.setSystemPrompt(getCurrentSystemPrompt());
  watcher.startPolling();
  await sendToAgent("The user has just opened the editor. Call list_files to see the project, then greet them briefly.");
}

boot().catch((err) => {
  console.error("Boot failed:", err);
  const chat = document.querySelector("coach-chat");
  if (chat) chat.addMessage("system", `Failed to initialize: ${err.message}`);
});

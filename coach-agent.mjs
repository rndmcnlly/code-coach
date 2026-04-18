// =========================================================================
// PairAgent : OpenAI-compatible LLM client with tool-calling loop
//
// Plain class (no DOM dependency). Constructed with config, wired by boot.
//
// Constructor: new PairAgent({ apiBase, model, apiKey })
// Methods:
//   setSystemPrompt(prompt)
//   async send(content, { onToolCalls, onResponse, onError })
// =========================================================================

// Tool declarations (OpenAI JSON Schema format)
const TOOL_DEFS = [

  // ---- FileStore tools (bypass tabs, direct FS access) ----
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the project FileStore. Call this on your first turn to understand the project structure.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file directly from the FileStore without opening a tab. Use for config files, AGENTS.md, reference docs -- anything you need to read but not edit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path as returned by list_files" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content directly to the FileStore (creates or overwrites). Use for new files or when you want to write without a tab workflow. If the file is already open in a tab, the tab will be refreshed to reflect the new content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Full file content" }
        },
        required: ["path", "content"]
      }
    }
  },

  // ---- Tab management ----
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "List all currently open editor tabs, their paths, dirty state, and which is active.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "open_tab",
      description: "Open a file from the FileStore in the editor as a tab, making it active. Required before using get_code, edit_text, or edit_node on a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to open (must exist in FileStore)" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "close_tab",
      description: "Close an open editor tab. Unsaved changes are discarded.",
      parameters: {
        type: "object",
        properties: {
          tab_path: { type: "string", description: "Path of the tab to close" }
        },
        required: ["tab_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_file",
      description: "Save an open tab's current content to the FileStore. Only needed if autosave was disabled on an edit. By default, edit_text and edit_node autosave.",
      parameters: {
        type: "object",
        properties: {
          tab_path: { type: "string", description: "Path of the tab to save" }
        },
        required: ["tab_path"]
      }
    }
  },

  // ---- Code inspection and editing ----
  {
    type: "function",
    function: {
      name: "get_code",
      description: "Get the current source of an open tab with 1-indexed line numbers. Use before any edit to confirm current content.",
      parameters: {
        type: "object",
        properties: {
          tab_path: { type: "string", description: "Path of the open tab to read" }
        },
        required: ["tab_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_text",
      description: "Replace a line range in an open tab. autosave=true by default (writes to FileStore immediately). To insert without replacing, set startLine and endLine to the same line. To delete, set newText to empty string.",
      parameters: {
        type: "object",
        properties: {
          tab_path: { type: "string", description: "Path of the open tab to edit" },
          startLine: { type: "number", description: "First line of range (1-indexed)" },
          endLine: { type: "number", description: "Last line of range (1-indexed, inclusive)" },
          newText: { type: "string", description: "Replacement text (may be multiple lines or empty)" },
          autosave: { type: "boolean", description: "Write to FileStore after edit (default: true)" }
        },
        required: ["tab_path", "startLine", "endLine", "newText"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_node",
      description: `Replace an AST node in an open tab found by a tree-sitter query. Preferred over edit_text for structural edits -- resilient to line-number drift. autosave=true by default.

Common query patterns for JavaScript:
  (function_declaration name: (identifier) @name (#eq? @name "create")) @target
  (lexical_declaration (variable_declarator name: (identifier) @name (#eq? @name "config"))) @target

If the query is invalid or matches nothing, falls back gracefully -- use edit_text instead.`,
      parameters: {
        type: "object",
        properties: {
          tab_path: { type: "string", description: "Path of the open tab to edit" },
          query: { type: "string", description: "Tree-sitter S-expression query with @target capture" },
          index: { type: "number", description: "0-based match index if multiple nodes match (default: 0)" },
          newText: { type: "string", description: "Replacement text for the matched node" },
          autosave: { type: "boolean", description: "Write to FileStore after edit (default: true)" }
        },
        required: ["tab_path", "query", "newText"]
      }
    }
  },

  // ---- Annotation ----
  {
    type: "function",
    function: {
      name: "highlight_lines",
      description: "Highlight a line span in an open tab and attach an inline annotation comment. Your primary visual output. Use freely to answer questions, flag issues, point at patterns. The annotation appears as subtle trailing text. User can dismiss via gutter X.",
      parameters: {
        type: "object",
        properties: {
          tab_path: { type: "string", description: "Path of the open tab to annotate" },
          startLine: { type: "number", description: "First line to highlight (1-indexed)" },
          endLine: { type: "number", description: "Last line to highlight (1-indexed, inclusive)" },
          message: { type: "string", description: "Short annotation text (1-2 sentences)" },
          linkUrl: { type: "string", description: "Optional documentation URL" },
          linkLabel: { type: "string", description: "Label for the link (defaults to 'docs')" }
        },
        required: ["tab_path", "startLine", "endLine", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "highlight_node",
      description: "Highlight an AST node in an open tab found by a tree-sitter query, with an annotation. Same query syntax as edit_node.",
      parameters: {
        type: "object",
        properties: {
          tab_path: { type: "string", description: "Path of the open tab to annotate" },
          query: { type: "string", description: "Tree-sitter S-expression query with @target capture" },
          index: { type: "number", description: "0-based match index if multiple nodes match (default: 0)" },
          message: { type: "string", description: "Short annotation text" },
          linkUrl: { type: "string", description: "Optional documentation URL" },
          linkLabel: { type: "string", description: "Label for the link" }
        },
        required: ["tab_path", "query", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clear_highlights",
      description: "Remove all active highlights and annotations from the editor.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "suggest_fix",
      description: "Propose a small inline quick-fix in an open tab. Shows Apply/Dismiss buttons on the line. Use for typos, casing fixes, single-line corrections. The user clicks Apply or Dismiss -- you are notified either way.",
      parameters: {
        type: "object",
        properties: {
          tab_path: { type: "string", description: "Path of the open tab" },
          line: { type: "number", description: "Line number to attach the fix to (1-indexed)" },
          oldText: { type: "string", description: "Exact text to replace on that line" },
          newText: { type: "string", description: "Replacement text" },
          message: { type: "string", description: "Short description of the fix" }
        },
        required: ["tab_path", "line", "oldText", "newText", "message"]
      }
    }
  },

  // ---- Preview ----
  {
    type: "function",
    function: {
      name: "run_preview",
      description: "Run the active tab in the preview iframe. HTML files run directly; JS files are wrapped in a minimal shell. If the code references Phaser, Phaser 4 CDN is injected automatically. Do NOT auto-run -- only run when the user asks or to test after a requested change.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "screenshot_preview",
      description: "Capture a screenshot of the preview iframe. If a canvas element is present (e.g. Phaser), it is captured directly. Otherwise html2canvas captures the full viewport. You receive the image as a follow-up message.",
      parameters: { type: "object", properties: {} }
    }
  },

  // ---- Blackboard ----
  {
    type: "function",
    function: {
      name: "read_blackboard",
      description: "Read the current content of the shared blackboard (markdown).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "write_blackboard",
      description: "Write to the shared blackboard. Use to post doc links, notes, context, or summaries relevant to what the user is working on. Supports markdown: **bold**, *italic*, [links](url), ## headings, - lists. mode='replace' overwrites; mode='append' adds below existing content.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Markdown content to write" },
          mode: { type: "string", enum: ["replace", "append"], description: "replace (default) or append" }
        },
        required: ["content"]
      }
    }
  },

  // ---- UI panel control ----
  {
    type: "function",
    function: {
      name: "get_ui_state",
      description: "Get the current visibility state of all collapsible UI panels.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "set_panel_visible",
      description: "Show or collapse a UI panel. Use to focus the workspace (e.g. hide tasks/log while reviewing code, show preview before running). Panels: 'tasks', 'log', 'preview'.",
      parameters: {
        type: "object",
        properties: {
          panel: { type: "string", enum: ["files", "tasks", "log", "preview"], description: "Which panel to change" },
          visible: { type: "boolean", description: "true to expand, false to collapse" }
        },
        required: ["panel", "visible"]
      }
    }
  },

  // ---- Todo list ----
  {
    type: "function",
    function: {
      name: "add_todo",
      description: "Add a task to the todo list. Keep it short and concrete.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_todo",
      description: "Mark a todo item done. Pass exact text or unique substring.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "uncomplete_todo",
      description: "Reopen a completed todo item.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remove_todo",
      description: "Remove a todo item entirely.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_todo",
      description: "Edit the text of an existing todo item.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Current text (or substring) to match" },
          newText: { type: "string", description: "Replacement text" }
        },
        required: ["text", "newText"]
      }
    }
  },
];

export class PairAgent {
  #apiBase;
  #model;
  #apiKey;
  #messages = [];
  #systemPrompt = "";
  #tools = TOOL_DEFS;
  #ready = false;
  #responding = false;

  /**
   * @param {Object} config
   * @param {string} config.apiBase  – e.g. "https://api.bayleaf.dev/v1"
   * @param {string} config.model    – e.g. "qwen/qwen3.5-35b-a3b"
   * @param {string} [config.apiKey] – Bearer token (optional)
   */
  constructor({ apiBase, model, apiKey = "" }) {
    this.#apiBase = apiBase;
    this.#model = model;
    this.#apiKey = apiKey;
  }

  get ready() { return this.#ready; }
  get responding() { return this.#responding; }

  setSystemPrompt(prompt) {
    this.#systemPrompt = prompt;
    this.#messages = [{ role: "system", content: prompt }];
    this.#ready = true;
  }

  /**
   * Send a message to the agent.
   * @param {string|Array} content – plain text or OpenAI content parts array
   * @param {Object} callbacks
   * @param {function(Array): Promise<Array>} callbacks.onToolCalls
   * @param {function(string): void} callbacks.onResponse
   * @param {function(string): void} callbacks.onError
   */
  async send(content, { onToolCalls, onResponse, onError }) {
    if (!this.#ready) return null;
    this.#responding = true;
    this.#messages.push({ role: "user", content });
    try {
      return await this.#completionLoop(onToolCalls, onResponse);
    } catch (err) {
      console.error("Agent error:", err);
      onError?.(err.message);
      return null;
    } finally {
      this.#responding = false;
    }
  }

  async #completionLoop(onToolCalls, onResponse) {
    let guard = 0;
    while (guard++ < 10) {
      const headers = { "Content-Type": "application/json" };
      if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;

      const res = await fetch(`${this.#apiBase}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.#model,
          messages: this.#messages,
          tools: this.#tools,
          temperature: 0.8,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error("No choices in response");

      const msg = choice.message;
      this.#messages.push(msg);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const parsedCalls = [];
        for (const tc of msg.tool_calls) {
          try {
            parsedCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments),
            });
          } catch (parseErr) {
            console.warn(`Truncated tool call "${tc.function.name}":`, parseErr.message);
          }
        }

        if (parsedCalls.length === 0) {
          this.#messages.push({
            role: "user",
            content: "[System: your last tool call was truncated (malformed JSON). Please retry with shorter arguments, or respond with text.]",
          });
          continue;
        }

        const toolResults = await onToolCalls(parsedCalls);
        for (const r of toolResults) {
          this.#messages.push({
            role: "tool",
            tool_call_id: r.tool_call_id,
            content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
          });
        }
        continue;
      }

      const text = msg.content?.trim() || null;
      if (text) onResponse?.(text);
      return text;
    }

    console.warn("Agent tool-calling loop exceeded 10 iterations");
    return null;
  }
}

// Backward-compat alias
export { PairAgent as CoachAgent };

// =========================================================================
// CoachAgent : OpenAI-compatible LLM client with tool-calling loop
//
// Plain class (no DOM dependency). Constructed with config, wired by boot.
//
// Constructor: new CoachAgent({ apiBase, model, apiKey })
// Methods:
//   setSystemPrompt(prompt)
//   async send(content, { onToolCalls, onResponse, onError })
// =========================================================================

// Tool declarations (OpenAI JSON Schema format)
const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "edit_text",
      description: "Replace a range of lines in the editor with new text. Low-level line-based edit. Use when you need precise control or when edit_node can't target what you need. Line numbers are 1-indexed. To insert without replacing, set startLine and endLine to the same line. To delete lines, set newText to empty string.",
      parameters: {
        type: "object",
        properties: {
          startLine: { type: "number", description: "First line of range to replace (1-indexed)" },
          endLine: { type: "number", description: "Last line of range to replace (1-indexed, inclusive)" },
          newText: { type: "string", description: "Replacement text (can be multiple lines, or empty to delete)" }
        },
        required: ["startLine", "endLine", "newText"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_node",
      description: `Replace an AST node found by a tree-sitter query. Preferred over edit_text for structural edits: resilient to line-number drift. The @target capture determines which node gets replaced.

Common query patterns for JavaScript:
  (function_declaration name: (identifier) @name (#eq? @name "create")) @target
  (variable_declaration (variable_declarator name: (identifier) @name (#eq? @name "config"))) @target
  (expression_statement (call_expression function: (member_expression property: (property_identifier) @prop (#eq? @prop "add")))) @target
  (lexical_declaration (variable_declarator name: (identifier) @name (#eq? @name "game"))) @target

If the query is invalid or matches nothing, you'll get an error. Fall back to edit_text if needed.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tree-sitter S-expression query. Must include a @target capture for the node to replace." },
          index: { type: "number", description: "0-based match index if multiple nodes match (default: 0, i.e. first match)" },
          newText: { type: "string", description: "Replacement text for the matched node" }
        },
        required: ["query", "newText"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "highlight_lines",
      description: "Highlight a span of lines in the editor and attach a rich annotation comment visible inline. Use to call attention to a specific section: a bug, a pattern worth noting, or a place that needs work. The annotation supports HTML including links. Only one highlight can be active at a time (previous is cleared).",
      parameters: {
        type: "object",
        properties: {
          startLine: { type: "number", description: "First line to highlight (1-indexed)" },
          endLine: { type: "number", description: "Last line to highlight (1-indexed, inclusive)" },
          message: { type: "string", description: "Short annotation text (plain text, 1-2 sentences)" },
          linkUrl: { type: "string", description: "Optional documentation URL to include in the annotation" },
          linkLabel: { type: "string", description: "Label for the link (defaults to 'docs')" }
        },
        required: ["startLine", "endLine", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "highlight_node",
      description: `Highlight an AST node found by a tree-sitter query and attach an annotation. Same query syntax as edit_node. Preferred over highlight_lines for structural targets: survives line-number drift.

Uses the same @target capture convention as edit_node.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tree-sitter S-expression query with @target capture for the node to highlight." },
          index: { type: "number", description: "0-based match index if multiple nodes match (default: 0)" },
          message: { type: "string", description: "Short annotation text (plain text, 1-2 sentences)" },
          linkUrl: { type: "string", description: "Optional documentation URL to include in the annotation" },
          linkLabel: { type: "string", description: "Label for the link (defaults to 'docs')" }
        },
        required: ["query", "message"]
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
      name: "get_code",
      description: "Get the current full source code from the editor. Use when you need to read the code outside of an automatic update.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "suggest_fix",
      description: "Propose a small quick-fix inline in the editor. Shows a widget with Apply and Dismiss buttons on the affected line. Use for typos, misspellings, casing fixes, small one-line corrections. The student clicks Apply to accept (no chat needed) or Dismiss to reject. You will be notified of the outcome. Do NOT use for large refactors.",
      parameters: {
        type: "object",
        properties: {
          line: { type: "number", description: "The line number to attach the fix to (1-indexed)" },
          oldText: { type: "string", description: "The exact text to find and replace on that line" },
          newText: { type: "string", description: "The replacement text" },
          message: { type: "string", description: "Short description of the fix (e.g. 'typo: plyrHelth -> playerHealth')" }
        },
        required: ["line", "oldText", "newText", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_todo",
      description: "Add a task to the student's todo list. Use to suggest next steps, track what needs doing, or break down a larger goal. The coach maintains this list automatically as the student codes.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Short task description (e.g. 'Add player sprite in create')" }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_todo",
      description: "Mark a todo item as done. Use when you observe the student has completed something on the list. Pass the exact text or a unique substring of the task to match it.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The task text (or substring) to mark complete" }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "uncomplete_todo",
      description: "Mark a completed todo item as not done. Use when you realize a task needs more work, or the student's code regressed.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The task text (or substring) to mark incomplete" }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remove_todo",
      description: "Remove a todo item entirely. Use when a task is no longer relevant.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The task text (or substring) to remove" }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_todo",
      description: "Edit the text of an existing todo item. Use to fix typos, clarify wording, or update a task description.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The current task text (or substring) to match" },
          newText: { type: "string", description: "The replacement text" }
        },
        required: ["text", "newText"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_preview",
      description: "Run the student's code in the game preview iframe. Loads the current editor code with the Phaser 4 CDN and executes it. Returns any console output (logs, warnings, errors) from the run. Use when: the student asks to run, you want to test if their code works, or you notice they have not run in a while after significant changes.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "screenshot_preview",
      description: "Capture a screenshot of the game preview canvas. You will receive the image as a follow-up so you can see what the game looks like. Use to check visual output, verify sprites are rendering, or when the student asks 'how does it look'. The game must be running first.",
      parameters: { type: "object", properties: {} }
    }
  }
];

export class CoachAgent {
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

  /** Set the system prompt (must be called before first send). */
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
   *   Receives parsed tool calls [{id, name, arguments}], must return
   *   [{tool_call_id, content: string}...]
   * @param {function(string): void} callbacks.onResponse – final text response
   * @param {function(string): void} callbacks.onError    – error message
   * @returns {Promise<string|null>} final text response
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
      const body = {
        model: this.#model,
        messages: this.#messages,
        tools: this.#tools,
        temperature: 0.8,
      };

      const headers = { "Content-Type": "application/json" };
      if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;

      const res = await fetch(`${this.#apiBase}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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

      // Check for tool calls
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

        // If all calls were truncated, tell the model to retry shorter
        if (parsedCalls.length === 0) {
          this.#messages.push({
            role: "user",
            content: "[System: your last tool call was truncated (malformed JSON). Please try again with shorter arguments, or respond with text instead.]",
          });
          continue;
        }

        // Dispatch to caller and wait for results
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

      // No tool calls: final text response
      const text = msg.content?.trim() || null;
      if (text) onResponse?.(text);
      return text;
    }

    console.warn("Agent tool-calling loop exceeded 10 iterations");
    return null;
  }
}

// =========================================================================
// <coach-agent> : OpenAI-compatible LLM with tool-calling loop
//
// Attributes: api-base, model, api-key-name (localStorage key for Bearer token)
// Methods:
//   async send(content)        – content is string or array (for multimodal)
//   async submitToolResults(results) – array of {tool_call_id, content}
//   get ready                  – boolean
// Events dispatched on document:
//   "agent-ready"              – after init
//   "agent-response"           – detail: { text }
//   "agent-error"              – detail: { error }
//   "agent-tool-calls"         – detail: { calls: [{id, name, arguments}], resolve }
//     The orchestrator must call resolve(results) where results is
//     [{tool_call_id, content: string}...] to continue the loop.
// =========================================================================
class CoachAgent extends HTMLElement {
  #apiBase = "";
  #model = "";
  #apiKey = "";
  #messages = [];   // OpenAI-format message history
  #systemPrompt = "";
  #tools = [];      // OpenAI-format tool definitions
  #ready = false;
  #responding = false;

  // ---- Tool declarations (OpenAI JSON Schema format) ----
  static TOOL_DEFS = [
    {
      type: "function",
      function: {
        name: "edit_code",
        description: "Replace a range of lines in the editor with new text. Use to fix bugs, insert code, or delete lines. Line numbers are 1-indexed. To insert without replacing, set startLine and endLine to the same line. To delete lines, set newText to empty string.",
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

  get ready() { return this.#ready; }
  get responding() { return this.#responding; }

  connectedCallback() {
    this.#apiBase = this.getAttribute("api-base") || "https://api.bayleaf.dev/v1";
    this.#model = this.getAttribute("model") || "qwen/qwen3.5-35b-a3b";
    const keyName = this.getAttribute("api-key-name") || "BAYLEAF_API_KEY";
    this.#apiKey = localStorage.getItem(keyName) || "";
    this.#tools = CoachAgent.TOOL_DEFS;
  }

  /** Set the system prompt (must be called before first send). */
  setSystemPrompt(prompt) {
    this.#systemPrompt = prompt;
    this.#messages = [{ role: "system", content: prompt }];
    this.#ready = true;
    document.dispatchEvent(new CustomEvent("agent-ready"));
  }

  /**
   * Send a message to the agent. Content can be:
   *   - a string (plain text user message)
   *   - an array of OpenAI content parts (for multimodal, e.g. image_url + text)
   * Returns the final text response (or null).
   */
  async send(content) {
    if (!this.#ready) return null;
    this.#responding = true;

    // Build the user message
    const userMsg = typeof content === "string"
      ? { role: "user", content }
      : { role: "user", content };  // array content parts are valid OpenAI format
    this.#messages.push(userMsg);

    try {
      return await this.#completionLoop();
    } catch (err) {
      console.error("Agent error:", err);
      document.dispatchEvent(new CustomEvent("agent-error", { detail: { error: err.message } }));
      return null;
    } finally {
      this.#responding = false;
    }
  }

  /** Continue after tool results have been submitted. */
  async submitToolResults(results) {
    // results: [{tool_call_id, content}...]
    for (const r of results) {
      this.#messages.push({
        role: "tool",
        tool_call_id: r.tool_call_id,
        content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      });
    }
    return this.#completionLoop();
  }

  async #completionLoop() {
    let guard = 0;
    while (guard++ < 10) {
      const body = {
        model: this.#model,
        messages: this.#messages,
        tools: this.#tools,
        temperature: 0.8,
        // No max_tokens cap: edit_code tool calls carry full replacement
        // text, which can be large during refactors. Let the model (or
        // upstream API) decide its own completion length.
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

      // Append assistant message to history
      this.#messages.push(msg);

      // Check for tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Parse arguments defensively: the model may return truncated JSON
        // if the response was cut off by max_tokens.
        const parsedCalls = [];
        let truncated = false;
        for (const tc of msg.tool_calls) {
          try {
            parsedCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments),
            });
          } catch (parseErr) {
            console.warn(`Truncated tool call "${tc.function.name}":`, parseErr.message);
            truncated = true;
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

        // Dispatch valid calls to orchestrator and wait for results
        const toolResults = await new Promise((resolve) => {
          document.dispatchEvent(new CustomEvent("agent-tool-calls", {
            detail: { calls: parsedCalls, resolve }
          }));
        });

        // Push tool results into history and loop
        for (const r of toolResults) {
          this.#messages.push({
            role: "tool",
            tool_call_id: r.tool_call_id,
            content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
          });
        }
        continue; // next iteration of completion loop
      }

      // No tool calls: we have a final text response
      const text = msg.content?.trim() || null;
      if (text) {
        document.dispatchEvent(new CustomEvent("agent-response", { detail: { text } }));
      }
      return text;
    }

    // Guard exceeded
    console.warn("Agent tool-calling loop exceeded 10 iterations");
    return null;
  }
}
customElements.define("coach-agent", CoachAgent);

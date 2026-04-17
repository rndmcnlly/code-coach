# Code Coach

A computational caricature of a live programming coach for game development.

## Inspiration

This prototype grew out of a [Live-Coaches](https://github.com/ivalmart/Live-Coaches) project that pairs an AI coach with a Super Metroid emulator: the coach watches gameplay via frame captures and memory reads, then reacts with spoken guidance. The question was: can the same "live coach" concept transfer from game-playing to game-making?

The deeper motivation comes from the **Live Coding (LC)** tradition in music and performance, where the act of writing code is itself the performance. In LC, the audience sees the code as it forms, and the performer's edits are the expressive medium. We wanted to explore what happens when you put an AI in the position of a live audience member who also happens to be a domain expert: watching the code take shape, reacting to structural changes, occasionally pointing at something and commenting.

The framing is deliberately a **computational caricature**, not a production system. The goal is to demonstrate the concept of translating live-coding aesthetics into computer science education, not to build a tool that "actually works" at scale. If it convincingly shows the interaction pattern, it has succeeded.

## Concept

The student writes Phaser 4 game code in a Monaco editor. An AI coach watches in real time, parsing the code with tree-sitter every second to detect when the AST stabilizes after edits. When it detects a meaningful structural change (including identifier renames that preserve AST structure), it reacts: a short spoken observation, an annotation on the relevant code span, or silence.

The interaction model is **point-and-talk**:

- The **student** communicates by selecting code + speaking or typing. The selection is deictic: "this thing here." The input bar lives below the editor, showing which lines are selected.
- The **coach** communicates by annotating code spans + speaking. Annotations appear as subtle trailing text on lines (via CSS `::after`), with a dismissable X glyph in the gutter. The coach also maintains a todo list and can propose quick-fixes inline.

The interface has a **four-panel layout**: code editor (dominant), game preview (below editor), task list (middle), and log sidebar (right). The chat log exists for observability during demos, not as the primary interaction surface. The code editor is the shared workspace where both participants point and gesture.

## Design Principles

Two principles constrain the design of every feature:

**Full observability.** The agent sees every meaningful user action. Not raw keystrokes, but debounced, semantically grouped signals: code stabilized, cursor lingered, todo toggled, annotation dismissed, quick-fix applied. The user is never doing something the agent doesn't know about.

**Capability symmetry.** If the agent can do it, the user can too, and vice versa. The todo list is the cleanest example: both sides add, complete, uncomplete, remove, edit. Neither has a privileged operation the other lacks. If a future feature gives the agent a new affordance, the user should get the same, and if the user gets a new interaction, the agent should be able to do it too.

The one intentional asymmetry: the agent can't type in the editor directly (that would be creepy). It goes through `edit_text`/`edit_node`/`suggest_fix`, which have consent gates. That asymmetry is by design, not a gap.

## Design Decisions

**Hybrid architecture: components + plain modules.** The application is 10 ES modules loaded from a shell `index.html`. Modules with visual presence (editor, chat, game preview, todo list, speech) are Web Components. Modules that are pure logic (agent, AST watcher, effects) are plain exported classes constructed by the orchestrator with explicit dependencies. This split enables testability: the logic modules can be imported and tested from Node without a DOM. A `boot.mjs` orchestrator wires everything together via callbacks and a thin layer of `CustomEvent` dispatch for UI-to-orchestrator communication.

**OpenAI-compatible LLM via BayLeaf API.** The `CoachAgent` class makes direct `fetch` calls to `api.bayleaf.dev/v1/chat/completions`, an OpenAI-compatible proxy for UC Santa Cruz. On the campus network, no API key is needed. Off campus, a free BayLeaf key (`sk-bayleaf-...`) is required. The default model is `qwen/qwen3.5-35b-a3b` (vision-capable). The agent manages its own message history and tool-calling loop using the standard OpenAI `tool_calls` / `tool` role protocol.

**AST polling, not file-watching.** The coach re-parses once per second and compares S-expressions to detect stability. This is intentionally coarse: we want to react at the level of "you added a function" or "you changed the config," not "you typed a semicolon." Two consecutive identical parses trigger a coach reaction. Text-only changes (renames) that preserve AST structure are also detected by comparing raw code against the last coached snapshot.

**Cursor linger detection.** Beyond code changes, the watcher tracks whether the student's cursor stays on one line for an extended period (8s default). A lingering cursor may signal confusion, study, or being stuck. The agent receives a gentle prompt and can choose to offer help or stay silent.

**Tree-sitter WASM in browser.** Real incremental parsing, not regex heuristics. The JS grammar gives us actual AST nodes (function declarations, variable bindings, call expressions) which we diff at the top level to describe what changed. The same tree-sitter query language powers the `edit_node` and `highlight_node` tools, allowing the agent to target code structurally rather than by fragile line numbers. Loaded via pre-built UMD from unpkg.

**Cursor awareness.** Every code update includes the student's cursor line and its content, so the coach knows where the student is working. This enables contextual doc links (the coach knows the Phaser 4 docs URL pattern, including the lowercase hash fragment quirk).

**Consent for edits.** The coach can modify the student's code via `edit_text` or `edit_node`, but the system prompt enforces judgment-based consent: if the student explicitly asked for a change, that is consent. If the coach is initiating the change itself, it highlights first and asks. Taking over the keyboard without context is rude, especially in a pedagogical setting.

**Quick-fixes.** For small corrections (typos, casing, misspellings), the coach uses `suggest_fix` which shows an inline widget with Apply/Dismiss buttons right on the affected line. One click to accept, no chat round-trip needed. The coach is notified of the outcome.

**Dismissable annotations.** Annotations can be dismissed by clicking the gutter X (using `GUTTER_GLYPH_MARGIN` mouse target). Dismissal is reported back to the coach as a signal ("the student saw this and moved on"), closing the feedback loop.

**15-word response cap.** Coach responses are spoken aloud while the student is actively coding. Long explanations break flow. The hard word cap forces the model into the laconic register of a pair programmer who is mostly just watching: "Adding cursor keys, yep." or "That should be in preload."

**Manual game execution.** The student must consciously click Run (or Ctrl+Enter) to execute their code in the preview iframe. No auto-run: students need to learn about the request flow. When the student runs manually, the coach is notified and receives the console output after a short delay. The coach can also trigger a run via `run_preview` but is instructed to ask first.

**User-agent parity for the todo list.** Both the student and the coach can add, complete, uncomplete, remove, and edit tasks. The student uses inline UI (input field, click-to-toggle, double-click to edit, per-item remove button). The coach uses tool calls. All user-initiated actions notify the agent so it stays in sync. This symmetry lets the student proactively plan ("need to refactor later") and the coach can observe their thinking.

**Naming awareness.** The coach pays attention to identifier names, flagging inconsistent casing (mixing camelCase and snake_case), misspellings, and cryptic abbreviations. This is surfaced through annotations and quick-fixes.

## Architecture

```
index.html (HTML shell + CSS)
  └── boot.mjs (composition root, tool dispatch, event wiring)
        │
        ├── Custom elements (DOM-resident, visual):
        │   ├── code-editor.mjs    Monaco + decorations + quick-fix
        │   ├── game-preview.mjs   Iframe sandbox, console relay
        │   ├── todo-list.mjs      Task state + rendering + user interaction
        │   ├── coach-chat.mjs     Chat log, thinking indicator
        │   └── speech-io.mjs      Browser TTS + click-to-talk STT
        │
        ├── Plain modules (constructed by boot, no DOM dependency):
        │   ├── coach-agent.mjs    LLM client, tool-calling loop
        │   ├── ast-watcher.mjs    Tree-sitter polling, AST diff, cursor linger
        │   └── effects.mjs        SFX (jsfxr) + particles (canvas-confetti)
        │
        └── system-prompt.mjs      LLM system prompt

+--------------------+-----------+----------+
|  code-editor       | todo-list | coach-   |
|  Monaco + gutter   |           | chat     |
|  annotations +     | [x] task  | Log +    |
|  quick-fix widgets | [ ] task  | input    |
|                    | Add...    |          |
|  ast-watcher       |           |          |
|  tree-sitter polls |           |          |
|  cursor linger     |           |          |
+--------------------+           |          |
|  game-preview      |           |          |
|  Phaser iframe +   |           |          |
|  console capture   |           |          |
+--------------------+-----------+----------+
         |                          ^
         | code context:            | callbacks:
         | AST diff + code +        | onResponse, onToolCalls,
         | cursor + console +       | onError
         | todo state               |
         v                          |
   CoachAgent (plain class)
   OpenAI-compatible chat/completions
   via api.bayleaf.dev/v1
   Model: qwen/qwen3.5-35b-a3b

boot.mjs owns all inter-module wiring.
Custom elements dispatch events upward;
boot routes to plain modules via callbacks.
```

## Tool Inventory

| Tool | Consent | Purpose |
|------|---------|---------|
| `get_code` | No | Read current editor contents (with 1-indexed line numbers) |
| `edit_text` | Judgment | Replace a range of lines (low-level, line-based) |
| `edit_node` | Judgment | Replace an AST node by tree-sitter query (resilient to line drift) |
| `highlight_lines` | No | Annotate a code span by line range |
| `highlight_node` | No | Annotate an AST node by tree-sitter query |
| `clear_highlights` | No | Remove active annotations |
| `suggest_fix` | One-click | Propose an inline quick-fix (Apply/Dismiss buttons on the line) |
| `run_preview` | Ask first | Execute the student's code in the game preview iframe |
| `screenshot_preview` | No | Capture game canvas screenshot (bundled with console logs, sent as vision input) |
| `add_todo` | No | Add a task to the student's todo list |
| `complete_todo` | No | Mark a task done (auto-checked as coach observes code) |
| `uncomplete_todo` | No | Reopen a task (e.g. code regressed) |
| `remove_todo` | No | Remove an irrelevant task |
| `edit_todo` | No | Edit task text (fix typos, clarify wording) |

### Tree-sitter query tools

`edit_node` and `highlight_node` accept tree-sitter S-expression queries with a `@target` capture to identify the node. Common patterns:

```scheme
(function_declaration name: (identifier) @name (#eq? @name "create")) @target
(lexical_declaration (variable_declarator name: (identifier) @name (#eq? @name "config"))) @target
(expression_statement (call_expression function: (member_expression
  property: (property_identifier) @prop (#eq? @prop "add")))) @target
```

If the query is invalid or matches nothing, the tool returns a descriptive error and the agent can fall back to line-based tools.

## Voice and Feedback

Two voice modes via dropdown (voice always starts off each session):
- **Off**: captions only (text overlay at bottom of screen)
- **On**: browser Web Speech API (toggling on is the user gesture that unlocks `speechSynthesis`)

Sound effects via jsfxr (toggleable SFX button):
- Todo item added: pickupCoin variant (deterministic, frozen sfxr params)
- Todo item completed: pickupCoin variant (higher base frequency, punchy sustain)

Visual feedback:
- Confetti burst (canvas-confetti) when the coach places an annotation or triggers `run_preview`
- AST status indicator in the topbar (Editing / Settling / Stable / Syntax error)
- Coach thinking indicator: pulsing topbar pill + animated dots in chat log while waiting for LLM response
- Selection hint in the input bar showing which lines are selected
- All implicit agent messages (run, dismiss, quick-fix outcomes, todo changes) visible in the log

## Game Preview

The bottom of the editor pane contains a sandboxed iframe that runs the student's Phaser 4 code:
- Loads `phaser@4.0.0` from CDN
- Console methods (`log`, `warn`, `error`) are patched to `postMessage` back to the parent
- Uncaught errors and unhandled promise rejections are captured
- Console output appears below the iframe and is included in code updates to the coach
- Screenshots bundle console output alongside the image for full runtime context
- **Share logs** button sends console output to the coach on demand (for runtime errors from interactive play that occur after the last code edit)
- No auto-run: the student clicks Run or presses Ctrl/Cmd+Enter

## Dependencies (all loaded from CDN)

- **Monaco Editor** 0.52.2: code editor with glyph margin, decorations, content widgets
- **web-tree-sitter** 0.24.7 + **tree-sitter-javascript** 0.23.1: AST parsing and query (UMD from unpkg)
- **jsfxr** (sfxr.me): procedural 8-bit sound effects
- **canvas-confetti** 1.9.4: particle effects
- **marked**: markdown rendering in the log sidebar
- **Web Speech API**: browser-native TTS and STT
- **Phaser 4.0.0**: loaded in the preview iframe from CDN

LLM inference via [BayLeaf API](https://api.bayleaf.dev) (OpenAI-compatible, zero-data-retention).

## Running

```bash
# Any static HTTP server works
cd code-coach
python3 -m http.server 8888
open http://localhost:8888
```

**On the UCSC campus network**: no setup needed. The BayLeaf API accepts requests without authentication.

**Off campus**: get a free API key at [api.bayleaf.dev](https://api.bayleaf.dev), then set it in the browser console:
```javascript
localStorage.setItem("BAYLEAF_API_KEY", "sk-bayleaf-...")
```

## Progress

- [x] Monaco editor with Phaser 4 starter code
- [x] Tree-sitter WASM parsing with AST diff on stabilization
- [x] Text-only change detection (identifier renames that preserve AST structure)
- [x] Cursor line included in every code update
- [x] Cursor linger detection (8s on same line triggers agent prompt)
- [x] OpenAI-compatible LLM integration with tool calling via BayLeaf API
- [x] Coach reacts to code changes with short spoken observations (15-word cap)
- [x] Annotation system: highlight lines or AST nodes, trailing text, hover tooltips, docs links
- [x] Dismissable annotations via gutter X click, with coach notification
- [x] Quick-fix system: inline Apply/Dismiss widget for one-click corrections
- [x] Point-and-talk: student selection included as context in messages
- [x] Browser TTS (Web Speech API)
- [x] STT input (Web Speech Recognition, mic button)
- [x] Judgment-based consent for code edits
- [x] Game preview iframe with Phaser 4 CDN and console capture
- [x] Coach-triggered run via `run_preview` tool
- [x] Screenshot capture sent to coach as vision input (with console logs bundled)
- [x] Share Logs button for runtime errors from interactive play
- [x] Todo list with full user-agent parity (add, complete, uncomplete, remove, edit)
- [x] Deterministic sfxr sound effects for todo interactions (toggleable)
- [x] canvas-confetti particle effects on annotations and coach-triggered runs
- [x] Log sidebar for demo observability (context messages, tool call traces)
- [x] Console output fed back to coach for runtime error awareness
- [x] Phaser 4 docs URL pattern in system prompt (lowercase hash fragment quirk)
- [x] Naming and style awareness (casing, spelling, clarity of identifiers)
- [x] 1-indexed line numbers in all code sent to the model
- [x] Hybrid architecture: Web Components (visual) + plain modules (logic, testable)
- [x] Thinking indicator (topbar pill + chat dots) during LLM requests
- [x] Truncation recovery for tool-call JSON parse errors
- [x] Student-run notification: agent sees console output when student clicks Run
- [x] All user actions notify the agent (todo, run, dismiss, quick-fix, screenshot)
- [x] AST-aware editing and highlighting via tree-sitter query (`edit_node`, `highlight_node`)
- [ ] Multiple annotation layers (currently one highlight at a time)
- [ ] Persistent coach memory across page reloads
- [ ] Configurable coach persona
- [ ] Richer AST diff (tree edit distance instead of top-level S-expression comparison)

## Credits

- [Adam Smith](https://github.com/rndmcnlly) (amsmith@ucsc.edu)
- [Ivan Martinez-Arias](https://github.com/ivalmart) (ivalmart@ucsc.edu)

## Status

This is a research proof of concept, not a production system.

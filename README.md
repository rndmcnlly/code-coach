# Code Coach

A computational caricature of a live programming coach for game development.

## Inspiration

This prototype grew out of a Live-Coaches project that pairs an AI coach with a Super Metroid emulator: the coach watches gameplay via frame captures and memory reads, then reacts with spoken guidance. The question was: can the same "live coach" concept transfer from game-playing to game-making?

The deeper motivation comes from the **Live Coding (LC)** tradition in music and performance, where the act of writing code is itself the performance. In LC, the audience sees the code as it forms, and the performer's edits are the expressive medium. We wanted to explore what happens when you put an AI in the position of a live audience member who also happens to be a domain expert: watching the code take shape, reacting to structural changes, occasionally pointing at something and commenting.

The framing is deliberately a **computational caricature**, not a production system. The goal is to demonstrate the concept of translating live-coding aesthetics into computer science education, not to build a tool that "actually works" at scale. If it convincingly shows the interaction pattern, it has succeeded.

## Concept

The student writes Phaser 4 game code in a Monaco editor. An AI coach (Gemini 3 Flash) watches in real time, parsing the code with tree-sitter every second to detect when the AST stabilizes after edits. When it detects a meaningful structural change (including identifier renames that preserve AST structure), it reacts: a short spoken observation, an annotation on the relevant code span, or silence.

The interaction model is **point-and-talk**:

- The **student** communicates by selecting code + speaking or typing. The selection is deictic: "this thing here." The input bar lives below the editor, showing which lines are selected.
- The **coach** communicates by annotating code spans + speaking. Annotations appear as subtle trailing text on lines (via CSS `::after`), with a dismissable X glyph in the gutter. The coach also maintains a todo list and can propose quick-fixes inline.

The interface has a **four-panel layout**: code editor (dominant), game preview (below editor), task list (middle), and log sidebar (right). The chat log exists for observability during demos, not as the primary interaction surface. The code editor is the shared workspace where both participants point and gesture.

## Design Decisions

**Single-file HTML.** Optimized for pedagogical legibility and portability. Everything (editor, parser, AI integration, TTS/STT, tool system, game preview, todo list, particle effects, WebAudio feedback) lives in one file. Serve it with any static HTTP server.

**AST polling, not file-watching.** The coach re-parses once per second and compares S-expressions to detect stability. This is intentionally coarse: we want to react at the level of "you added a function" or "you changed the config," not "you typed a semicolon." Two consecutive identical parses trigger a coach reaction. Text-only changes (renames) that preserve AST structure are also detected by comparing raw code against the last coached snapshot.

**Tree-sitter WASM in browser.** Real incremental parsing, not regex heuristics. The JS grammar gives us actual AST nodes (function declarations, variable bindings, call expressions) which we diff at the top level to describe what changed. Loaded via pre-built UMD from unpkg to avoid the Node.js `fs` bundler error that jsdelivr/esm.run triggers.

**Cursor awareness.** Every code update includes the student's cursor line and its content, so the coach knows where the student is working. This enables contextual doc links (the coach knows the Phaser 4 docs URL pattern, including the lowercase hash fragment quirk).

**Consent for edits.** The coach can modify the student's code via `edit_code`, but the system prompt enforces judgment-based consent: if the student explicitly asked for a change, that is consent. If the coach is initiating the change itself, it highlights first and asks. Taking over the keyboard without context is rude, especially in a pedagogical setting.

**Quick-fixes.** For small corrections (typos, casing, misspellings), the coach uses `suggest_fix` which shows an inline widget with Apply/Dismiss buttons right on the affected line. One click to accept, no chat round-trip needed. The coach is notified of the outcome.

**Dismissable annotations.** Annotations can be dismissed by clicking the gutter X (using `GUTTER_GLYPH_MARGIN` mouse target). Dismissal is reported back to the coach as a signal ("the student saw this and moved on"), closing the feedback loop.

**15-word response cap.** Coach responses are spoken aloud while the student is actively coding. Long explanations break flow. The hard word cap forces the model into the laconic register of a pair programmer who is mostly just watching: "Adding cursor keys, yep." or "That should be in preload."

**Manual game execution.** The student must consciously click Run (or Ctrl+Enter) to execute their code in the preview iframe. No auto-run: students need to learn about the request flow. The coach can trigger a run via `run_preview` but is instructed to ask first.

**Naming awareness.** The coach pays attention to identifier names, flagging inconsistent casing (mixing camelCase and snake_case), misspellings, and cryptic abbreviations. This is surfaced through annotations and quick-fixes.

## Architecture

```
Browser
+--------------------+-----------+----------+
|  Monaco Editor     | Tasks     | Log      |
|  (code + gutter    | (todo     | (chat    |
|   annotations)     |  list)    |  sidebar)|
|                    |           |          |
| [tree-sitter polls |           |          |
|  AST every 1s]     |           |          |
|                    |           |          |
| [input: select +   |           |          |
|  type/speak]       |           |          |
+--------------------+           |          |
|  Game Preview      |           |          |
|  (Phaser iframe)   |           |          |
| [console capture]  |           |          |
+--------------------+-----------+----------+
         |                          ^
         | AST diff + code +        | text + tool calls
         | cursor + console +       |
         | todo state               |
         v                          |
   Gemini 3 Flash (function calling)
   Tools: get_code, highlight_lines,
          edit_code, clear_highlights,
          suggest_fix, run_preview,
          add_todo, complete_todo,
          remove_todo
```

## Tool Inventory

| Tool | Consent | Purpose |
|------|---------|---------|
| `get_code` | No | Read current editor contents (with 1-indexed line numbers) |
| `highlight_lines` | No | Annotate a code span (trailing text, blue highlight, hover tooltip with optional docs link, particle burst) |
| `clear_highlights` | No | Remove active annotations |
| `suggest_fix` | One-click | Propose an inline quick-fix (Apply/Dismiss buttons on the line) |
| `edit_code` | Judgment | Replace a range of lines (student-requested: just do it; coach-initiated: ask first) |
| `run_preview` | Ask first | Execute the student's code in the game preview iframe |
| `add_todo` | No | Add a task to the student's todo list |
| `complete_todo` | No | Mark a task done (auto-checked as coach observes code) |
| `remove_todo` | No | Remove an irrelevant task |

## Voice and Feedback

Three voice modes via dropdown:
- **Off**: captions only (text overlay at bottom of screen)
- **Fast**: browser Web Speech API (instant, robotic)
- **Best**: Gemini 3.1 Flash TTS (high quality, some latency, Kore voice, falls back to browser on error)

Sound effects (toggleable SFX button):
- Todo item added: quick ascending sine blip
- Todo item completed: two-note ascending chime

Visual feedback:
- Particle burst (blue sparkles) when the coach places an annotation
- Particle burst on the Run button when the coach triggers `run_preview`
- AST status indicator in the topbar (Editing / Settling / Stable / Syntax error)
- Selection hint in the input bar showing which lines are selected

## Game Preview

The bottom of the editor pane contains a sandboxed iframe that runs the student's Phaser 4 code:
- Loads `phaser@4.0.0` from CDN
- Console methods (`log`, `warn`, `error`) are patched to `postMessage` back to the parent
- Uncaught errors and unhandled promise rejections are captured
- Console output appears below the iframe and is included in code updates to the coach
- No auto-run: the student clicks Run or presses Ctrl+Enter

## Dependencies (all loaded from CDN)

- **Monaco Editor** 0.52.2: code editor with glyph margin, decorations, content widgets
- **web-tree-sitter** 0.24.7 + **tree-sitter-javascript** 0.23.1: AST parsing (UMD from unpkg)
- **@google/genai**: Gemini SDK (function calling with `id` passthrough for Gemini 3, chat sessions)
- **Gemini 3.1 Flash TTS**: optional high-quality voice (PCM audio decoded and played via WebAudio)
- **marked**: markdown rendering in the log sidebar
- **Web Speech API**: browser-native TTS and STT
- **Phaser 4.0.0**: loaded in the preview iframe from CDN

## Running

```bash
# Any static HTTP server works
cd code-coach
python3 -m http.server 8888
open http://localhost:8888
```

Requires `GEMINI_API_KEY` in `localStorage`. Set it in the browser console:
```javascript
localStorage.setItem("GEMINI_API_KEY", "your-key-here")
```

## Progress

Built in a single session as a proof of concept.

- [x] Monaco editor with Phaser 4 starter code
- [x] Tree-sitter WASM parsing with AST diff on stabilization
- [x] Text-only change detection (identifier renames that preserve AST structure)
- [x] Cursor line included in every code update
- [x] Gemini 3 Flash integration with function calling (tools with `id` passthrough)
- [x] Coach reacts to code changes with short spoken observations (15-word cap)
- [x] Annotation system: highlight lines, trailing `::after` text, hover tooltips, docs links
- [x] Dismissable annotations via gutter X click, with coach notification
- [x] Quick-fix system: inline Apply/Dismiss widget for one-click corrections
- [x] Point-and-talk: student selection included as context in messages
- [x] Three-mode TTS: off, browser (fast), Gemini 3.1 Flash TTS (best)
- [x] STT input (Web Speech Recognition, mic button + Space push-to-talk)
- [x] Judgment-based consent for code edits
- [x] Game preview iframe with Phaser 4 CDN and console capture
- [x] Coach-triggered run via `run_preview` tool (with particle effect)
- [x] Todo list maintained silently by the coach (add, complete, remove)
- [x] WebAudio sound effects for todo interactions (toggleable)
- [x] Particle effects on annotations and coach-triggered runs
- [x] Log sidebar for demo observability (context messages, tool call traces)
- [x] Console output fed back to coach for runtime error awareness
- [x] Phaser 4 docs URL pattern in system prompt (lowercase hash fragment quirk)
- [x] Naming and style awareness (casing, spelling, clarity of identifiers)
- [x] 1-indexed line numbers in all code sent to the model
- [ ] Multiple annotation layers (currently one highlight at a time)
- [ ] Persistent coach memory across page reloads
- [ ] Configurable coach persona
- [ ] Richer AST diff (tree edit distance instead of top-level S-expression comparison)
- [ ] Screenshot of the game preview sent to the coach for visual feedback

## Status

This is a single-session proof of concept, not a production system.

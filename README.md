# Pair Agent ✨

A browser-based shell for transagentic pair programming: a human and an LLM agent
sharing a code editor, a file system, a preview iframe, and a blackboard.

The agent's role is not fixed. Depending on the `AGENTS.md` file in the project
and the persona selected at startup, it can be a pair programmer watching code
stabilize and reacting briefly, a tutor asking questions, a code reviewer flagging
issues, or a scribe transcribing patterns from a human demonstration.

This grew out of [Live-Coaches](https://github.com/ivalmart/Live-Coaches), a prototype
pairing an AI coach with a Super Metroid emulator (watching gameplay via frame captures
and memory reads), and a follow-on Code Coach prototype applying the same live-coach
concept to a student writing Phaser 4 games in a Monaco editor. The generalization
here: the domain-specific coaching role is injected via `AGENTS.md` and persona
presets, not baked in. The shell itself is domain-agnostic.

The framing is a **research prototype**, not a production system. The goal is to
demonstrate the transagentic interaction pattern: a coherent acting entity that
emerges at the interface between human and agent, neither one the instrument of
the other.

## Concept

The human works in a Monaco editor with multi-tab support. The agent watches
code changes via tree-sitter AST polling, reacts when edits stabilize, and
communicates by annotating code spans and speaking short responses (15-word cap,
TTS-live). Both sides share a todo list and a blackboard scratchpad.

The interaction model is **point-and-talk**: the human selects a code span and
speaks or types -- the selection is deictic ("this thing here"). The agent
annotates spans in response. Neither side dominates; the shared workspace is the
primary surface.

The project can be opened as an in-memory sandbox (default, two starter files)
or pointed at a real local directory via `showDirectoryPicker`. In the latter
case the agent can read `.git` and other hidden files to understand repo state.

## Design Principles

**Full observability.** The agent sees every meaningful user action as a typed
signal: code stabilized (with AST diff), cursor lingered, tab switched, todo
toggled, annotation dismissed, quick-fix applied, panel collapsed, blackboard
updated. The user is never doing something the agent doesn't know about.

**Capability symmetry.** If the agent can do it, the user can too. The todo list
and blackboard are the clearest examples: both sides read and write. Agent edits
go through `edit_text`/`edit_node`/`suggest_fix` with consent gates -- the one
intentional asymmetry (the agent can't type directly in the editor).

**Role injection, not role baking.** The agent's persona is a parameter, not an
assumption. The shell system prompt is generic. Domain knowledge and behavioral
constraints live in `AGENTS.md` (project-level) and the persona preset selector
(session-level). Unchecking the AGENTS.md checkbox tells the agent to ignore it.

**Minimal footprint.** No build step, no bundler, no npm. The entire project is
static ES modules served by any HTTP server. All dependencies load from CDN.

## Architecture

```
index.html (HTML shell + CSS)
  └── boot.mjs (composition root: tool dispatch, event wiring, FileStore)
        │
        ├── Custom elements (DOM-resident, visual):
        │   ├── code-editor.mjs    Monaco, multi-tab, decorations, quick-fix
        │   ├── file-browser.mjs   Left sidebar: file tree, right-click, drag-to-move
        │   ├── game-preview.mjs   iframe sandbox (HTML or bare JS), console relay
        │   ├── blackboard.mjs     Shared markdown scratchpad, quiescence detection
        │   ├── todo-list.mjs      Task state, rendering, user interaction
        │   ├── coach-chat.mjs     Log sidebar, thinking indicator, user input
        │   └── speech-io.mjs      Browser TTS + STT
        │
        ├── Plain modules (no DOM dependency):
        │   ├── coach-agent.mjs    LLM client (PairAgent), tool-calling loop
        │   ├── ast-watcher.mjs    Tree-sitter polling, AST diff, cursor linger
        │   └── effects.mjs        SFX (jsfxr) + particles (canvas-confetti)
        │
        ├── file-store.mjs         MemoryFileStore + LocalDirectoryStore
        └── system-prompt.mjs      Base prompt + PERSONAS presets + buildSystemPrompt()

+--------+--------------------+-----------+----------+
| FILES  |  code-editor       | tasks     | LOG      |
|        |  Monaco + tabs     | todo list | agent    |
| tree   |  gutter anns       |-----------|  chat    |
|        |  quick-fix         | blackboard|          |
|        |                    | markdown  |          |
|        |--------------------|           |          |
|        |  preview (iframe)  |           |          |
+--------+--------------------+-----------+----------+
```

`boot.mjs` is the sole composition root. Custom elements dispatch `CustomEvent`s
upward; boot routes them to plain modules via callbacks. No module imports another
module directly except through boot.

**FileStore** is a two-backend abstraction:
- `MemoryFileStore` -- default, session-scoped, zero setup
- `LocalDirectoryStore` -- `showDirectoryPicker()`, real files on disk, walks
  `.git` and hidden dirs (skips `node_modules`, `__pycache__`)

## Panels

All panels except the editor are collapsible. Click the panel header to toggle.
The agent can also collapse/expand panels via `set_panel_visible`.

| Panel | Location | Collapsible | Description |
|-------|----------|-------------|-------------|
| Files | Left sidebar | Yes | File tree: right-click to create/rename/delete, drag to move |
| Editor | Center top | No | Monaco, multi-tab, gutter annotations, quick-fix widgets |
| Preview | Center bottom | Yes (starts collapsed) | iframe: runs HTML files directly, wraps bare JS in a shell |
| Tasks | Right-center top | Yes | Todo list: user and agent have full parity |
| Blackboard | Right-center bottom | No | Shared markdown scratchpad |
| Log | Far right | Yes | Agent responses, tool call traces, system events |

## Tool Inventory

### File and Tab Tools

| Tool | Purpose |
|------|---------|
| `list_files()` | All files in FileStore (including `.git`, hidden dirs) |
| `read_file(path)` | Read any file without opening a tab |
| `write_file(path, content)` | Write directly to FileStore; refreshes tab if open |
| `list_tabs()` | Open tabs with dirty state and active flag |
| `open_tab(path)` | Open a file as an editor tab (required before editing) |
| `close_tab(tab_path)` | Close a tab (unsaved changes discarded) |
| `save_file(tab_path)` | Write tab content to FileStore (edit tools autosave by default) |

### Code Editing Tools

| Tool | Consent | Purpose |
|------|---------|---------|
| `get_code(tab_path)` | No | Numbered source of an open tab |
| `edit_text({tab_path, startLine, endLine, newText, autosave?})` | Judgment | Line-range replacement |
| `edit_node({tab_path, query, newText, autosave?})` | Judgment | Replace AST node by tree-sitter query |
| `suggest_fix({tab_path, line, oldText, newText, message})` | One-click | Inline Apply/Dismiss widget |

`edit_text` and `edit_node` default to `autosave=true` (write through to FileStore immediately).
Pass `autosave=false` to keep the edit in the tab only, then call `save_file` explicitly.

### Annotation Tools

| Tool | Purpose |
|------|---------|
| `highlight_lines({tab_path, startLine, endLine, message, linkUrl?, linkLabel?})` | Annotate a line span |
| `highlight_node({tab_path, query, message, ...})` | Annotate an AST node |
| `clear_highlights()` | Remove active annotation |

Annotations appear as subtle trailing text on the annotated line (via CSS `::after`).
The user dismisses them by clicking the X glyph in the gutter; the agent is notified.

### Preview Tools

| Tool | Consent | Purpose |
|------|---------|---------|
| `run_preview()` | Ask first | Run active tab in iframe (HTML runs directly; JS is wrapped) |
| `screenshot_preview()` | No | Capture iframe: canvas element (fast) or html2canvas fallback |

### Blackboard

| Tool | Purpose |
|------|---------|
| `read_blackboard()` | Read current markdown content |
| `write_blackboard({content, mode?})` | Write markdown: `mode='replace'` (default) or `'append'` |

The blackboard is a shared contenteditable markdown scratchpad. Agent and user
both write here. User edits quiesce after 2s before the agent is notified.
Use for: doc links, API references, architectural notes, task context.

### UI Tools

| Tool | Purpose |
|------|---------|
| `get_ui_state()` | Current visibility of all panels |
| `set_panel_visible(panel, visible)` | Show or collapse a panel: `files`, `tasks`, `log`, `preview` |

### Todo Tools

| Tool | Purpose |
|------|---------|
| `add_todo(text)` | Add a task |
| `complete_todo(text)` | Mark done (substring match) |
| `uncomplete_todo(text)` | Reopen |
| `remove_todo(text)` | Remove entirely |
| `edit_todo(text, newText)` | Rename |

### Tree-sitter Query Tools

`edit_node` and `highlight_node` accept tree-sitter S-expression queries with a
`@target` capture. These are JS/TS only; for other file types the tools fall back
to line-based equivalents.

```scheme
(function_declaration name: (identifier) @name (#eq? @name "create")) @target
(lexical_declaration (variable_declarator name: (identifier) @name (#eq? @name "config"))) @target
```

## Personas and AGENTS.md

The agent's persona is set at session start via two controls in the topbar:

**Persona preset dropdown** -- built-in roles:

| Preset | Description |
|--------|-------------|
| Pair Programmer | Watches code, reacts briefly, flags bugs. Default. |
| Code Reviewer | Annotates issues, flags anti-patterns, honest not validating. |
| Tutor | Asks questions to prompt thinking, explains when relevant. |
| Scribe | Observes and transcribes patterns; records to blackboard or docs. |
| Phaser Game Coach | Pair programmer with Phaser 4 API knowledge and doc links. |

**AGENTS.md checkbox** -- if checked (default), the agent reads `AGENTS.md` from
the project root on startup and follows any instructions it contains. These can
override or extend the system prompt: role, rules, domain knowledge, first-turn
behavior. Uncheck to ignore AGENTS.md (useful when opening a repo whose AGENTS.md
was written for a different kind of agent, e.g. an agentic coding tool).

The default in-memory project includes a starter `AGENTS.md` you can edit.

## Voice and Feedback

**Voice:** browser Web Speech API TTS. Off by default (toggling on is the user
gesture that unlocks `speechSynthesis`). Agent responses are spoken live -- the
15-word cap keeps them in the laconic register of a pair programmer mostly watching.

**STT:** mic button or Space to push-to-talk. Transcript is inserted into the
input field and sent.

**Captions:** fullscreen overlay of the last agent utterance. Toggleable.

**SFX:** deterministic jsfxr sounds for todo add/complete. Toggleable.

**Visual:** canvas-confetti on annotations and agent-triggered runs. AST status
pill in the topbar (Editing / Settling / Stable / Syntax error -- JS/TS only).
Agent thinking indicator: pulsing topbar pill + animated dots in the log.

## Running

```bash
# Any static HTTP server works -- no build step
cd pair-agent
python3 -m http.server 8000
open http://localhost:8000
```

**On the UCSC campus network:** no setup needed. The BayLeaf API accepts requests
without authentication.

**Off campus:** get a free API key at [api.bayleaf.dev](https://api.bayleaf.dev),
then paste it in the browser console:

```javascript
localStorage.setItem("BAYLEAF_API_KEY", "sk-bayleaf-...")
```

**Local directory:** click "Open Directory" in the topbar to point the shell at
a real project on disk. The agent can then read any file including `.git`.

## Dependencies

All loaded from CDN -- no install step.

| Library | Version | Purpose |
|---------|---------|---------|
| Monaco Editor | 0.52.2 | Code editor: glyph margin, decorations, content widgets, multi-model |
| web-tree-sitter | 0.24.7 | AST parsing WASM runtime |
| tree-sitter-javascript | 0.23.1 | JS/TS grammar for AST diff and structural queries |
| marked | latest (ESM) | Markdown rendering in log and blackboard |
| html2canvas | 1.4.1 | Fallback screenshot for non-canvas preview content |
| jsfxr / riffwave | sfxr.me | Procedural 8-bit SFX |
| canvas-confetti | 1.9.4 | Particle effects on annotations and runs |
| Web Speech API | browser-native | TTS + STT |
| Phaser | 4.0.0 | Injected into preview iframe when code references `Phaser` |

LLM inference via [BayLeaf API](https://api.bayleaf.dev) (OpenAI-compatible,
zero-data-retention). Default model: `qwen/qwen3.5-35b-a3b` (vision-capable,
needed for `screenshot_preview`).

## Credits

- [Adam Smith](https://github.com/rndmcnlly) (amsmith@ucsc.edu) -- UC Santa Cruz
- [Ivan Martinez-Arias](https://github.com/ivalmart) (ivalmart@ucsc.edu) -- original Code Coach prototype

## Status

Research prototype. Not a production system.

Known gaps:
- Only one annotation active at a time (single highlight layer)
- AST diff is top-level S-expression comparison, not tree edit distance
- No persistent agent memory across page reloads
- File browser drag-to-move and right-click context menu are partially stubbed
- `setValue` dirty-suppression flag is not fully thread-safe under rapid edits

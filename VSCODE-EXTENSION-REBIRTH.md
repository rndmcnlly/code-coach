# VSCode Extension Rebirth ✨

A design document for rebirthing Pair Agent as a VSCode extension,
preserving the transagentic interaction pattern while gaining real-project
integration. The browser shell remains a separate deployment for the
zero-install teaching use case; both share the same agent core.

## Motivation

Pair Agent's core insight is **environmental reactivity**: the agent
watches the human work and decides when to act, rather than waiting for
explicit turns. The browser shell demonstrates this, but it requires the
human to work inside an embedded Monaco editor on a web page. For people
already living in VSCode, the friction of switching to a separate tool
outweighs the benefit of the agent's presence.

A VSCode extension can deliver the same reactive pattern where people
actually code, with access to real filesystems, language servers, git
state, and terminal output. The question is whether the feeling survives
the platform change.

## What Ports Cleanly

These modules are pure logic with no DOM dependency. They move to the
extension host almost verbatim:

| Module | Change needed |
|--------|---------------|
| `coach-agent.mjs` | None. A fetch loop with tool-calling. Trivial Node port. |
| `system-prompt.mjs` | None. Pure string construction from persona presets. |
| `file-store.mjs` | `MemoryFileStore` is unused (VSCode has the real FS). `LocalDirectoryStore` is replaced by `workspace.fs`. The `detectLanguage` helper stays. |

The tool definitions (the `TOOL_DEFS` array in `coach-agent.mjs`) are
OpenAI JSON Schema format and transfer directly. The consent model
(explicit request = auto, agent-initiated = ask first) is pure policy.

The persona preset system (`PERSONAS` map + `buildSystemPrompt()`) is
entirely string-level composition. No changes.

## What VSCode Replaces

These modules exist because the browser shell had to build from scratch
what VSCode already provides:

| Module | VSCode primitive |
|--------|------------------|
| `code-editor.mjs` | VSCode *is* Monaco. Decorations map to `TextEditor.setDecorations()`. Quick-fix maps to `CodeActionProvider`. Tab tracking is built in. The entire 533-line custom element vanishes. |
| `file-browser.mjs` | Built-in explorer. Gone entirely. |
| `ast-watcher.mjs` (polling) | `onDidChangeTextDocument` fires on every keystroke. `onDidChangeDiagnostics` gives language server errors. `onDidChangeTextEditorSelection` fires on cursor/selection change. All push-based, no polling. |

The AST watcher's tree-sitter query feature (`edit_node`, `highlight_node`)
has no direct VSCode equivalent: VSCode doesn't expose its internal AST.
Options: (a) drop structural queries and use line-based editing only, (b)
run tree-sitter WASM in the extension host (works in Node 20+), or (c)
use VSCode's `DocumentSymbolProvider` API for a coarser structural
navigation.

## What Needs Rearchitecting

These modules are browser-only and need to be rebuilt as webview panels
or replaced with VSCode-native alternatives:

### Chat log (`coach-chat.mjs`)

Options:
- **Webview panel**: full control over layout, closest to current feel.
  Requires `postMessage` bridge between extension host (agent logic) and
  webview (rendering).
- **Chat participant API** (`vscode.chat`): native inline chat, but
  still proposed/unstable. Would integrate with Copilot Chat's UI.
- **Output channel**: simplest, but read-only and not conversational.

Webview panel is the right starting point for a research prototype.

### Blackboard (`blackboard.mjs`)

A contenteditable markdown scratchpad. Maps to a webview panel with
quiescence detection (same 2s debounce as current). Loses the
"always visible alongside code" quality unless pinned as a side panel.

### Todo list (`todo-list.mjs`)

Could be a `vscode.TreeView` with checkboxes (native feel, limited
layout control) or a webview panel (flexible, same feel as current).
TreeView integrates with VSCode's panel system; webview gives more
control over the UX.

### Preview (`game-preview.mjs`)

The iframe sandbox maps to a webview panel. Phaser injection and
console relay need careful CSP handling. Screenshot capture
(`html2canvas`) only works inside the webview.

### Speech I/O (`speech-io.mjs`)

Web Speech API is browser-only. Could run TTS/STT inside a webview
panel and relay to the extension host via messaging. Awkward but
feasible. Likely dropped from v1.

### Effects (`effects.mjs`)

SFX (jsfxr) could run in a hidden webview. Confetti is probably not
worth porting. The audio feedback channel is genuinely useful (the
15-word spoken response is a core part of the interaction model), but
it's an enhancement, not a requirement.

## The Sentinel Pattern: Reactive Observation Without Context Bloat

The most important architectural innovation for the VSCode version.

### The Problem

The current code-coach fires a full agent turn on every stabilized edit
or cursor linger event. This means either:
- You burn context on "Mhm." responses, or
- You throttle events and lose observability.

In a real coding session, the human might make dozens of edits before
anything worth commenting on happens. The agent should see everything
but only speak when it matters.

### The Architecture

```
Event stream → ring buffer (bounded, aging) → sentinel → { pass | respond }
                                                        ↓ respond
                                                   promote to conversation
```

**Ring buffer**: a fixed-size circular buffer of typed events, living
outside the conversation history. Events age out naturally. The buffer
captures the full observable stream: edits, selection changes, cursor
dwells, diagnostic changes, tab switches, terminal output, etc.

**Sentinel**: a decision function invoked on each new event. It sees the
current event and a rolling window of recent events from the buffer.
Its job is binary: `pass` (do nothing) or `respond` (promote).

**Pass**: the event is discarded from the conversation's perspective.
No tokens consumed, no turn taken. The ring buffer retains it for
context in future sentinel evaluations, but the LLM conversation
history is unaffected. A two-hour quiet session might produce 3
conversation turns instead of 50.

**Respond**: the relevant event window is promoted into the conversation
as a single user turn. The agent sees not just the triggering event but
the recent context: "Edited line 7 four times, undid twice, cursor
lingering 20s, diagnostic: unused variable." The ring buffer gives this
for free.

### The Pass Tool

The sentinel can be implemented three ways, in escalating sophistication:

**Layer 1: Rules and heuristics** (zero token cost)
- Syntax error from language server: always promote
- Same line edited 3+ times without progress: promote (stuck)
- Cursor dwell > 15s after stability: promote
- Minor whitespace/formatting change: always discard
- New file opened and immediately closed: discard
- File opened + 30s of inactivity: promote (might be lost)

Covers ~80% of cases. Start here.

**Layer 2: Cheap model screening** (~200 tokens in, 1 token out)
- A small/fast model sees the rolling event summary and decides:
  "Respond?" / "Pass."
- Catches patterns rules miss: "wrote a loop, deleted it, wrote it
  differently" suggests confusion even if no single event crosses a
  threshold.
- Negligible cost on a small model.

**Layer 3: The pass tool** (main model, context manipulation)
- Every event gets a real agent call, but the agent has a `pass()` tool.
- When `pass()` is called, the entire turn (event message + tool call +
  tool result) is stripped from the conversation history before the next
  turn. It never happened.
- The agent gets the purest judgment: it sees the full context and
  decides whether this event deserves a conversational response.
- The key property: **so long as the agent keeps calling `pass()`, the
  conversation history does not grow.** You can dink around for
  arbitrarily long without clogging the context window.

Layer 3 is the most elegant and the one that best preserves the
"environmental agent" feel. The agent is always watching, always
thinking, but only speaking when it has something to say. The
conversation history reflects only the substantive interactions.

Layer 1 is the practical starting point. Layer 2 is the refinement.
Layer 3 is the aspiration.

### Event Types

The ring buffer stores typed events. Each event includes a timestamp,
the active file, and relevant details:

| Event | Source | Payload |
|-------|--------|---------|
| `edit` | `onDidChangeTextDocument` | file, range, diff summary |
| `selection` | `onDidChangeTextEditorSelection` | file, range, selected text |
| `cursor_dwell` | timer on selection stability | file, line, duration, line content |
| `stabilized` | debounce on `edit` | file, full numbered source, diagnostic summary |
| `diagnostic` | `onDidChangeDiagnostics` | file, errors/warnings |
| `tab_switch` | `onDidChangeActiveTextEditor` | from file, to file |
| `terminal_output` | `onDidStartTaskShellExecution` | command, output snippet |
| `save` | `onDidSaveTextDocument` | file |
| `blackboard_edit` | webview message | quiesced content |
| `todo_change` | webview message | action, text |

The sentinel sees these as they arrive and maintains its rolling window.

### Context Stripping Detail

When `pass()` is invoked:

1. The last user message (the event) is removed from the message array.
2. The assistant's `pass()` tool call and its result are removed.
3. The conversation is seamless: the next real event sees a history
   with no gap, just the prior substantive turns.

This requires the agent loop to buffer the most recent exchange and
commit it to history only if the turn was non-pass. Implementation:

```
async completionLoop() {
  while (guard++ < 10) {
    const response = await fetch(...)
    const msg = response.choices[0].message

    if (msg.tool_calls includes pass()) {
      // Strip: do NOT push msg or tool results to this.messages
      // The event vanishes from history
      break
    }

    // Normal flow: push to history
    this.messages.push(msg)
    // ... handle other tool calls, continue loop
  }
}
```

The agent's system prompt must explain `pass()` clearly:

> You have a `pass()` tool. Call it when you have nothing substantive
> to say about the current event. A passed turn is completely removed
> from the conversation: it costs no context and leaves no trace. Use
> it freely. Most events deserve a pass. Speak only when you have
> something worth the human's attention.

### Why This Matters for the Transagentic Pattern

The current code-coach enforces reactivity through a 15-word cap and
throttled event firing. The sentinel pattern achieves the same
restraint more gracefully: the agent can observe everything and
self-regulate. The human experiences an agent that is always present
but rarely intrusive, speaking only when it genuinely has something
to add. That is the core of the transagentic interaction: neither
party is the instrument of the other, and the shared orientation
toward the actual task is what makes the coupling functional.

## Gains and Losses

### Gained

- **Real filesystem**: `workspace.fs` gives native access, no
  `showDirectoryPicker` ceremony.
- **Language server diagnostics**: error detection for every installed
  language, not just JS/TS via tree-sitter.
- **Git integration**: `vscode.git` extension API for branch status,
  diff awareness, blame info.
- **Terminal awareness**: task and terminal output as event sources.
- **Users already live there**: no "open a URL" friction for that
  audience.
- **Marketplace distribution**: install from the extensions panel.
- **Settings, keybindings, workspace trust**: all the VSCode
  infrastructure.

### Lost

- **Zero-install URL openness**: the browser shell's strongest quality
  for classroom use. A VSCode extension requires installing VSCode,
  installing the extension, and opening a workspace.
- **No-build-step simplicity**: the current project is static ES
  modules served by any HTTP server. An extension needs esbuild/vite
  for bundling, npm for packaging, vsce for distribution.
- **Full UI control**: the current layout (editor + preview +
  blackboard + chat, all visible simultaneously) is hard to replicate
  in VSCode's panel system. The "shared workspace as primary surface"
  feel degrades.
- **Browser-only affordances**: Web Speech API, iframe sandbox,
  `showDirectoryPicker`.
- **Pedagogical clarity**: the single-file-per-concern architecture is
  immediately legible. A VSCode extension has a manifest, activation
  events, webview HTML as string templates, message passing protocols.

### Preserved (by design)

- The agent core: `PairAgent`, tool definitions, persona system,
  consent model, `AGENTS.md` resolution.
- Environmental reactivity (enhanced: more event sources, push-based).
- The sentinel/pass pattern (new, strictly better than the current
  throttle-and-hope approach).

## Target Architecture

```
┌─────────────────────────────────────────────────────┐
│  Extension Host (Node)                              │
│                                                     │
│  pair-agent/                                        │
│  ├── extension.ts          activation, commands     │
│  ├── agent/                                        │
│  │   ├── pair-agent.ts     ← coach-agent.mjs       │
│  │   ├── system-prompt.ts  ← system-prompt.mjs      │
│  │   ├── tool-defs.ts      ← TOOL_DEFS array        │
│  │   └── sentinel.ts       NEW: ring buffer + pass  │
│  ├── sensors/                                      │
│  │   ├── edit-sensor.ts    onDidChangeTextDocument  │
│  │   ├── selection-sensor.ts  selection + dwell     │
│  │   ├── diagnostic-sensor.ts  onDidChangeDiag      │
│  │   └── terminal-sensor.ts  task output            │
│  ├── tools/                                        │
│  │   ├── file-tools.ts     workspace.fs backed      │
│  │   ├── edit-tools.ts     workspace.applyEdit      │
│  │   ├── annotation-tools.ts  setDecorations        │
│  │   └── ui-tools.ts       panel visibility, etc    │
│  └── webviews/                                     │
│      ├── chat-panel.ts     coach-chat replacement   │
│      ├── blackboard-panel.ts  blackboard replacement │
│      └── preview-panel.ts  game-preview replacement │
│                                                     │
│  Event flow:                                        │
│  sensors → ring buffer → sentinel → agent.send()    │
│                                          ↓ pass()   │
│                                     strip from ctx  │
└─────────────────────────────────────────────────────┘

         ↕ postMessage (webview bridge)

┌─────────────────────────────────────────────────────┐
│  Webview Panels (Browser)                           │
│                                                     │
│  Chat: message log, user input, thinking indicator  │
│  Blackboard: contenteditable markdown, quiescence   │
│  Preview: iframe sandbox, console relay, Phaser     │
└─────────────────────────────────────────────────────┘
```

### Shared Agent Core

The `pair-agent` and `system-prompt` modules should be extracted into a
shared package that both the browser shell and the VSCode extension
import. The browser shell continues to serve the zero-install teaching
use case; the extension serves the real-project use case. Same agent,
different shells.

```
pair-agent-core/        ← npm package, shared
├── agent.ts            PairAgent class
├── system-prompt.ts    PERSONAS, buildSystemPrompt
├── tool-defs.ts        TOOL_DEFS array
└── types.ts            event types, tool signatures
```

## Implementation Path

### Phase 0: Extract the core

Pull `PairAgent`, `PERSONAS`, `buildSystemPrompt`, and `TOOL_DEFS` into
a shared package. The browser shell imports from this package. This is
a refactoring, not a rewrite.

### Phase 1: Skeleton extension

- `yo code` or manual: `package.json` manifest, `extension.ts`
  activation entry point.
- Wire `PairAgent` from the shared core.
- Implement file tools backed by `workspace.fs`.
- Implement edit tools backed by `workspace.applyEdit`.
- Implement annotation tools backed by `TextEditor.setDecorations`.
- A single command ("Start Pair Agent") that activates the agent with
  a hardcoded persona.

### Phase 2: Sensors and sentinel

- Implement `edit-sensor`, `selection-sensor`, `diagnostic-sensor`.
- Build the ring buffer.
- Implement the sentinel with Layer 1 (rules/heuristics) first.
- Wire the `pass()` tool into `PairAgent`'s completion loop with
  context stripping.

### Phase 3: Webview panels

- Chat panel: message log, user input, thinking indicator.
- Blackboard panel: markdown scratchpad with quiescence.
- Preview panel: iframe for running HTML/JS with console relay.

### Phase 4: Polish

- Persona selector via command palette or status bar dropdown.
- AGENTS.md checkbox toggle.
- Settings for API key, model, sentinel parameters.
- Layer 2 sentinel (cheap model screening) if Layer 1 proves
  insufficient.
- Speech I/O if it can be made to work via webview relay.

### Phase 5: Shared deployment

- Browser shell imports from `pair-agent-core`.
- Extension imports from `pair-agent-core`.
- Both run the same agent with the same tools and personas.
- The browser shell stays zero-install; the extension stays
  integrated.

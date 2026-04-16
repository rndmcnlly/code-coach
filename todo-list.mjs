// =========================================================================
// <todo-list> : Task state, rendering, add/complete/remove
//
// Methods:
//   addTodo(text)          – returns {success, todos}
//   completeTodo(text)     – returns {success, completed, todos} or {error}
//   removeTodo(text)       – returns {success, removed, todos} or {error}
//   summary()              – string summary for LLM context
// =========================================================================
import { escapeHtml } from "./utils.mjs";

class TodoList extends HTMLElement {
  #todos = [];
  #itemsEl = null;
  #countEl = null;

  connectedCallback() {
    this.#itemsEl = document.getElementById("todo-items");
    this.#countEl = document.getElementById("todo-count");
  }

  get todos() { return this.#todos; }

  summary() {
    if (this.#todos.length === 0) return "No tasks.";
    return this.#todos.map(t => `${t.done ? "[x]" : "[ ]"} ${t.text}`).join("\n");
  }

  addTodo({ text }) {
    this.#todos.push({ text, done: false });
    this.#render();
    document.dispatchEvent(new CustomEvent("sfx-play", { detail: { sound: "add" } }));
    return { success: true, todos: this.summary() };
  }

  completeTodo({ text }) {
    const lower = text.toLowerCase();
    const item = this.#todos.find(t => !t.done && t.text.toLowerCase().includes(lower));
    if (!item) return { error: `No pending todo matching "${text}"` };
    item.done = true;
    this.#render();
    document.dispatchEvent(new CustomEvent("sfx-play", { detail: { sound: "complete" } }));
    return { success: true, completed: item.text, todos: this.summary() };
  }

  removeTodo({ text }) {
    const lower = text.toLowerCase();
    const idx = this.#todos.findIndex(t => t.text.toLowerCase().includes(lower));
    if (idx === -1) return { error: `No todo matching "${text}"` };
    const removed = this.#todos.splice(idx, 1)[0];
    this.#render();
    return { success: true, removed: removed.text, todos: this.summary() };
  }

  #render() {
    this.#itemsEl.innerHTML = "";
    let pending = 0;
    this.#todos.forEach(t => {
      if (!t.done) pending++;
      const div = document.createElement("div");
      div.className = `todo-item${t.done ? " done" : ""}`;
      div.innerHTML = `<span class="todo-check">${t.done ? "\u2713" : ""}</span><span class="todo-text">${escapeHtml(t.text)}</span>`;
      this.#itemsEl.appendChild(div);
    });
    this.#countEl.textContent = pending > 0 ? pending : this.#todos.length > 0 ? "\u2713" : "0";
  }
}
customElements.define("todo-list", TodoList);

// =========================================================================
// <todo-list> : Task state, rendering, user + agent manipulation
//
// Methods (called by boot tool handlers):
//   addTodo({ text })          – returns {success, todos}
//   completeTodo({ text })     – returns {success, completed, todos} or {error}
//   uncompleteTodo({ text })   – returns {success, uncompleted, todos} or {error}
//   removeTodo({ text })       – returns {success, removed, todos} or {error}
//   editTodo({ text, newText })– returns {success, oldText, newText, todos} or {error}
//   summary()                  – string summary for LLM context
//
// Events dispatched on document (user interactions):
//   "user-todo-add"        – detail: { text }
//   "user-todo-toggle"     – detail: { text, done }
//   "user-todo-remove"     – detail: { text }
//   "user-todo-edit"       – detail: { oldText, newText }
// =========================================================================
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

class TodoList extends HTMLElement {
  #todos = [];
  #itemsEl = null;
  #countEl = null;

  connectedCallback() {
    this.#itemsEl = document.getElementById("todo-items");
    this.#countEl = document.getElementById("todo-count");

    // User add input
    const input = document.getElementById("todo-input");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const text = input.value.trim();
        if (!text) return;
        this.addTodo({ text });
        input.value = "";
        document.dispatchEvent(new CustomEvent("user-todo-add", { detail: { text } }));
      }
    });
  }

  get todos() { return this.#todos; }

  summary() {
    if (this.#todos.length === 0) return "No tasks.";
    return this.#todos.map(t => `${t.done ? "[x]" : "[ ]"} ${t.text}`).join("\n");
  }

  // --- Shared methods (agent tools + internal use) ---

  addTodo({ text }) {
    this.#todos.push({ text, done: false });
    this.#render();
    return { success: true, todos: this.summary() };
  }

  completeTodo({ text }) {
    const lower = text.toLowerCase();
    const item = this.#todos.find(t => !t.done && t.text.toLowerCase().includes(lower));
    if (!item) return { error: `No pending todo matching "${text}"` };
    item.done = true;
    this.#render();
    return { success: true, completed: item.text, todos: this.summary() };
  }

  uncompleteTodo({ text }) {
    const lower = text.toLowerCase();
    const item = this.#todos.find(t => t.done && t.text.toLowerCase().includes(lower));
    if (!item) return { error: `No completed todo matching "${text}"` };
    item.done = false;
    this.#render();
    return { success: true, uncompleted: item.text, todos: this.summary() };
  }

  removeTodo({ text }) {
    const lower = text.toLowerCase();
    const idx = this.#todos.findIndex(t => t.text.toLowerCase().includes(lower));
    if (idx === -1) return { error: `No todo matching "${text}"` };
    const removed = this.#todos.splice(idx, 1)[0];
    this.#render();
    return { success: true, removed: removed.text, todos: this.summary() };
  }

  editTodo({ text, newText }) {
    const lower = text.toLowerCase();
    const item = this.#todos.find(t => t.text.toLowerCase().includes(lower));
    if (!item) return { error: `No todo matching "${text}"` };
    const oldText = item.text;
    item.text = newText;
    this.#render();
    return { success: true, oldText, newText, todos: this.summary() };
  }

  // --- Rendering ---

  #render() {
    this.#itemsEl.innerHTML = "";
    let pending = 0;
    this.#todos.forEach((t, i) => {
      if (!t.done) pending++;
      const div = document.createElement("div");
      div.className = `todo-item${t.done ? " done" : ""}`;

      const check = document.createElement("span");
      check.className = "todo-check";
      check.textContent = t.done ? "\u2713" : "";
      check.addEventListener("click", (e) => { e.stopPropagation(); this.#toggleItem(i); });

      const textSpan = document.createElement("span");
      textSpan.className = "todo-text";
      textSpan.textContent = t.text;
      textSpan.addEventListener("dblclick", (e) => { e.stopPropagation(); this.#startEdit(i, textSpan); });

      const removeBtn = document.createElement("span");
      removeBtn.className = "todo-remove";
      removeBtn.textContent = "\u00d7";
      removeBtn.title = "Remove";
      removeBtn.addEventListener("click", (e) => { e.stopPropagation(); this.#userRemove(i); });

      div.appendChild(check);
      div.appendChild(textSpan);
      div.appendChild(removeBtn);
      this.#itemsEl.appendChild(div);
    });
    this.#countEl.textContent = pending > 0 ? pending : this.#todos.length > 0 ? "\u2713" : "0";
  }

  #toggleItem(index) {
    const item = this.#todos[index];
    if (!item) return;
    item.done = !item.done;
    this.#render();
    document.dispatchEvent(new CustomEvent("user-todo-toggle", {
      detail: { text: item.text, done: item.done }
    }));
  }

  #userRemove(index) {
    const item = this.#todos[index];
    if (!item) return;
    this.#todos.splice(index, 1);
    this.#render();
    document.dispatchEvent(new CustomEvent("user-todo-remove", {
      detail: { text: item.text }
    }));
  }

  #startEdit(index, spanEl) {
    const item = this.#todos[index];
    if (!item) return;
    const oldText = item.text;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "todo-edit-input";
    input.value = oldText;

    const finish = () => {
      const newText = input.value.trim();
      if (newText && newText !== oldText) {
        item.text = newText;
        document.dispatchEvent(new CustomEvent("user-todo-edit", {
          detail: { oldText, newText }
        }));
      }
      this.#render();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(); }
      if (e.key === "Escape") { this.#render(); }
    });
    input.addEventListener("blur", finish);

    spanEl.replaceWith(input);
    input.focus();
    input.select();
  }
}
customElements.define("todo-list", TodoList);

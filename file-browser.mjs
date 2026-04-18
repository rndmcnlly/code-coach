// =========================================================================
// <file-browser> : left sidebar file tree
//
// Displays the FileStore contents as a collapsible tree.
// Clicking a file dispatches "file-open" on document.
// The store reference is injected by boot via setStore(store).
// A refresh() method re-reads the store (call after store changes).
//
// Events dispatched on document:
//   "file-open"   – detail: { path }
// =========================================================================

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

class FileBrowser extends HTMLElement {
  #store = null;
  #activePath = null;
  #collapsed = false;
  #treeEl = null;
  #headerEl = null;
  // Which directory nodes are expanded: Set<string>
  #expanded = new Set();

  connectedCallback() {
    this.style.cssText = "display:flex;flex-direction:column;flex-shrink:0;";

    // Header bar
    this.#headerEl = document.createElement("div");
    this.#headerEl.id = "file-browser-header";
    this.#headerEl.title = "Toggle file browser";
    this.#headerEl.innerHTML = `
      <span class="panel-label">Files</span>
      <button id="file-refresh-btn" title="Refresh file list" style="margin-left:auto;background:none;border:none;color:#666;cursor:pointer;font-size:12px;padding:0 4px">&#x21BB;</button>
      <span class="panel-toggle">&#x25C4;</span>
    `;
    this.appendChild(this.#headerEl);

    // Tree container
    this.#treeEl = document.createElement("div");
    this.#treeEl.id = "file-tree";
    this.appendChild(this.#treeEl);

    // Collapse toggle (header click, but not the refresh button)
    this.#headerEl.addEventListener("click", (e) => {
      if (e.target.id === "file-refresh-btn") return;
      this.#toggleCollapse();
    });

    this.#headerEl.querySelector("#file-refresh-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      this.refresh();
    });
  }

  /** Called by boot.mjs to inject the store reference. */
  setStore(store) {
    this.#store = store;
    this.#expanded.clear();
    this.refresh();
  }

  /** Mark a path as the active (open) tab so it highlights. */
  setActivePath(path) {
    this.#activePath = path;
    this.#renderTree(this._lastFiles ?? []);
  }

  async refresh() {
    if (!this.#store) return;
    try {
      const files = await this.#store.listFiles();
      this._lastFiles = files.map(f => f.path);
      this.#renderTree(this._lastFiles);
    } catch (err) {
      this.#treeEl.textContent = `Error: ${err.message}`;
    }
  }

  // ---- Private ----

  #toggleCollapse() {
    this.#collapsed = !this.#collapsed;
    this.classList.toggle("collapsed", this.#collapsed);
    const toggle = this.#headerEl.querySelector(".panel-toggle");
    if (toggle) toggle.style.transform = this.#collapsed ? "rotate(180deg)" : "";
    document.dispatchEvent(new CustomEvent("file-browser-toggle", {
      detail: { visible: !this.#collapsed }
    }));
  }

  #renderTree(paths) {
    this.#treeEl.innerHTML = "";
    if (paths.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#444;font-style:italic;font-size:11px;padding:8px 12px;";
      empty.textContent = "No files.";
      this.#treeEl.appendChild(empty);
      return;
    }

    // Build a tree structure: { name, path?, children: Map }
    const root = { children: new Map() };
    for (const p of paths) {
      const parts = p.split("/");
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!node.children.has(part)) {
          node.children.set(part, {
            name: part,
            path: i === parts.length - 1 ? p : null,
            children: new Map(),
          });
        }
        node = node.children.get(part);
      }
    }

    this.#treeEl.appendChild(this.#renderNode(root, 0, ""));
  }

  #renderNode(node, depth, prefix) {
    const frag = document.createDocumentFragment();
    for (const [name, child] of node.children) {
      const isDir = child.children.size > 0;
      const fullPath = prefix ? `${prefix}/${name}` : name;
      const isExpanded = this.#expanded.has(fullPath);
      const isActive = child.path === this.#activePath;

      const row = document.createElement("div");
      row.className = "file-row" + (isDir ? " dir" : " file") + (isActive ? " active" : "");
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.dataset.path = fullPath;

      const icon = isDir ? (isExpanded ? "&#x25BE;" : "&#x25B8;") : this.#fileIcon(name);
      row.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(name)}</span>`;

      if (isDir) {
        row.addEventListener("click", () => {
          if (isExpanded) {
            this.#expanded.delete(fullPath);
          } else {
            this.#expanded.add(fullPath);
          }
          this.#renderTree(this._lastFiles ?? []);
        });
        frag.appendChild(row);
        if (isExpanded) {
          frag.appendChild(this.#renderNode(child, depth + 1, fullPath));
        }
      } else {
        row.addEventListener("click", () => {
          document.dispatchEvent(new CustomEvent("file-open", { detail: { path: child.path } }));
        });
        frag.appendChild(row);
      }
    }
    return frag;
  }

  #fileIcon(name) {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const icons = {
      js: "JS", mjs: "JS", ts: "TS", tsx: "TS", jsx: "JS",
      html: "HT", htm: "HT", css: "CS", json: "{}",
      md: "MD", yaml: "YM", yml: "YM", py: "PY",
      sh: "SH", txt: "TX",
    };
    return `<span class="file-ext-badge">${icons[ext] ?? "&#x1F4C4;"}</span>`;
  }
}
customElements.define("file-browser", FileBrowser);

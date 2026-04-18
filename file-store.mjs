// =========================================================================
// FileStore : in-memory and local-directory file storage backends
//
// Two implementations behind a common interface:
//   MemoryFileStore    – default, session-scoped, zero setup
//   LocalDirectoryStore – showDirectoryPicker(), real files on disk
//
// Interface (both classes):
//   async listFiles()                    – [{ path, writable }]
//   async readFile(path)                 – string content or throws
//   async writeFile(path, content)       – void or throws (creates parents)
//   async deleteFile(path)               – void or throws
//   async moveFile(oldPath, newPath)     – rename/move, throws on conflict
//   async createFolder(path)             – create empty directory marker
//   get name()                           – display name for the store
//   get writable()                       – bool: can files be written?
// =========================================================================

export class MemoryFileStore {
  #files = new Map(); // path -> string content

  constructor(initialFiles = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.#files.set(path, content);
    }
  }

  get name() { return "Memory"; }
  get writable() { return true; }

  async listFiles() {
    return [...this.#files.keys()].map(path => ({ path, writable: true }));
  }

  async readFile(path) {
    if (!this.#files.has(path)) throw new Error(`File not found: ${path}`);
    return this.#files.get(path);
  }

  async writeFile(path, content) {
    this.#files.set(path, content);
  }

  async deleteFile(path) {
    if (!this.#files.has(path)) throw new Error(`File not found: ${path}`);
    this.#files.delete(path);
  }

  async moveFile(oldPath, newPath) {
    if (!this.#files.has(oldPath)) throw new Error(`File not found: ${oldPath}`);
    if (this.#files.has(newPath)) throw new Error(`Destination already exists: ${newPath}`);
    this.#files.set(newPath, this.#files.get(oldPath));
    this.#files.delete(oldPath);
  }

  /** In memory, folders are implicit -- just creates a .keep placeholder. */
  async createFolder(path) {
    const keepPath = path.endsWith("/") ? `${path}.keep` : `${path}/.keep`;
    this.#files.set(keepPath, "");
  }
}

export class LocalDirectoryStore {
  #dirHandle = null;
  #name = "";

  constructor(dirHandle) {
    this.#dirHandle = dirHandle;
    this.#name = dirHandle.name;
  }

  get name() { return this.#name; }
  get writable() { return true; }

  // Recursively collect all file paths under the directory handle.
  async listFiles() {
    const results = [];
    await this.#walk(this.#dirHandle, "", results);
    return results;
  }

  async #walk(dirHandle, prefix, results) {
    for await (const [name, handle] of dirHandle.entries()) {
      // Skip high-noise directories that are never useful to browse
      if (name === "node_modules" || name === "__pycache__" || name === ".cache") continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "file") {
        results.push({ path, writable: true });
      } else if (handle.kind === "directory") {
        await this.#walk(handle, path, results);
      }
    }
  }

  async readFile(path) {
    const fileHandle = await this.#resolveFile(path, false);
    const file = await fileHandle.getFile();
    return await file.text();
  }

  async writeFile(path, content) {
    const fileHandle = await this.#resolveFile(path, true);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async deleteFile(path) {
    const parts = path.split("/");
    const fileName = parts.pop();
    let dir = this.#dirHandle;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    await dir.removeEntry(fileName);
  }

  /** Move/rename a file. File System Access API has no native move -- copy+delete. */
  async moveFile(oldPath, newPath) {
    const content = await this.readFile(oldPath);
    await this.writeFile(newPath, content);
    await this.deleteFile(oldPath);
  }

  /** Create an empty folder (creates a .keep file inside to materialize it). */
  async createFolder(path) {
    const parts = path.split("/");
    let dir = this.#dirHandle;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    // Write a .keep so the folder shows up in listings
    const keepHandle = await dir.getFileHandle(".keep", { create: true });
    const w = await keepHandle.createWritable();
    await w.write("");
    await w.close();
  }

  async #resolveFile(path, create) {
    const parts = path.split("/");
    const fileName = parts.pop();
    let dir = this.#dirHandle;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return await dir.getFileHandle(fileName, { create });
  }

  /** Factory: prompt user to pick a directory. Returns null if cancelled. */
  static async pick() {
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      return new LocalDirectoryStore(handle);
    } catch (err) {
      if (err.name === "AbortError") return null;
      throw err;
    }
  }
}

// ---- Language detection by extension ----

const EXT_LANGUAGE = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  jsx: "javascript",
  html: "html", htm: "html",
  css: "css",
  json: "json",
  md: "markdown",
  yaml: "yaml", yml: "yaml",
  py: "python",
  sh: "shell",
  toml: "toml",
  txt: "plaintext",
};

export function detectLanguage(path) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANGUAGE[ext] ?? "plaintext";
}

// ---- Default in-memory project ----

const DEFAULT_AGENTS_MD = `# AGENTS.md

This file configures your AI pair programming agent.
Edit it to set the agent's role, constraints, and domain knowledge.

## Role

You are a thoughtful pair programmer. Watch what the human is working on,
react when code changes stabilize, and offer brief observations.

## Rules

- Keep responses to 15 words or fewer -- you are speaking alongside active coding.
- Annotate code spans with highlight_lines rather than explaining in chat.
- Ask before making edits you were not explicitly asked to make.

## First Turn

Call list_tabs to see what files are open, then read AGENTS.md (already done),
then greet the human in one sentence.
`;

const DEFAULT_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>My Project</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; background: #1e1e1e; color: #d4d4d4; }
  </style>
</head>
<body>
  <h1>Hello, world!</h1>
  <p>Edit this file, then click <strong>Run</strong> to preview it.</p>
</body>
</html>
`;

export function makeDefaultMemoryStore() {
  return new MemoryFileStore({
    "AGENTS.md": DEFAULT_AGENTS_MD,
    "index.html": DEFAULT_INDEX_HTML,
  });
}

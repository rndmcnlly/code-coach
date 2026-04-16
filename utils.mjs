// =========================================================================
// Shared utilities
// =========================================================================
import { marked } from "https://esm.run/marked";

export function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

export { marked };

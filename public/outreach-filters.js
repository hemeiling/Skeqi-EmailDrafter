/* ══════════════════════════════════════════════════════════════════════
   Exhibitor Outreach — how a filter change merges with text being typed.

   The bug this exists to prevent: search and booth are debounced text
   boxes, so for ~300 ms what the user typed lives only in the box, not in
   the page's filter state. Any OTHER filter change in that window used to
   re-render every control from the state — writing the old text back into
   the box — and the pending debounce then read the wiped box. The search
   ran without the words the user had typed.

   The rule, in one place:
     • a text box is the source of truth for its own value, so every filter
       change first takes the boxes' current text;
     • unless the change sets that filter explicitly (Clear filters, removing
       a chip) — then the explicit value wins and is written to the box.

   Pure and shared: loaded by the page (window.xoMergeFilters) and required
   by the node test suite.
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  const TEXT_KEYS = ["q", "booth"];

  /**
   * @param {object} current   the page's filter state before this change
   * @param {object} patch     what this change sets explicitly
   * @param {object} typed     the text boxes' current values, e.g. { q, booth }
   * @returns {object}         the next filter state
   */
  function mergeFilters(current, patch, typed) {
    const next = { ...current };
    for (const key of TEXT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) continue;
      if (typed && typeof typed[key] === "string") next[key] = typed[key].trim();
    }
    Object.assign(next, patch || {});
    // A new search replaces a deep-linked single exhibitor, whichever path set it.
    if (next.q !== current.q && !Object.prototype.hasOwnProperty.call(patch || {}, "exhibitor")) next.exhibitor = "";
    return next;
  }

  const api = { mergeFilters, TEXT_KEYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.xoFilters = api;
})(typeof window !== "undefined" ? window : globalThis);

// ============================================================================
// inputs.js — shared text-entry behaviour for every input in the app.
//
// Two problems this fixes, both reported from on-device testing and both
// caused by how iOS treats a programmatically-touched selection:
//
//   1. "Cursor stays at the beginning of the text box." Calling
//      setSelectionRange() inside a rAF fights iOS's own late caret placement,
//      and the caret loses — it lands at 0, so typing prepends.
//   2. "Text box selection generally not great." Selecting-all on focus raises
//      iOS's blue drag handles and the magnifier loupe. Fiddly, and it looks
//      broken (see the reported Face Pulls / set-value screenshots).
//
// So we never select. Instead:
//   • numeric fields put the caret at the END and mark themselves "pristine";
//     the FIRST typed character replaces the whole value. That is what you
//     want after Add Set duplicates the previous set (25 -> type 3 -> "3"),
//     while backspace still edits the existing value normally.
//   • text fields are left alone unless iOS parked the caret at 0 on a
//     non-empty value, which is the bug — then, and only then, we move it to
//     the end. A deliberate mid-text tap is never overridden.
//
// Nothing here writes to the DB; commit handlers stay with their screens.
// ============================================================================

const HAS_BEFOREINPUT = typeof window !== 'undefined'
  && 'onbeforeinput' in window.HTMLInputElement.prototype;

/** Collapse the selection to the end of the value (no handles, no loupe). */
function caretToEnd(input) {
  const n = input.value.length;
  try { input.setSelectionRange(n, n); } catch { /* type doesn't support it */ }
}

/**
 * Attach the shared focus/typing behaviour to an input.
 *
 * @param {HTMLInputElement} input
 * @param {{replaceOnType?: boolean}} [opts]
 *   replaceOnType — numeric-field mode: caret to the end, first keystroke
 *   replaces the value. Off (the default) is plain text-field mode.
 * @returns {HTMLInputElement} the same input, for chaining into h().
 */
export function enhanceInput(input, { replaceOnType = false } = {}) {
  let pristine = false;

  input.addEventListener('focus', () => {
    if (replaceOnType) {
      pristine = HAS_BEFOREINPUT && input.value !== '';
      caretToEnd(input);
      // iOS places its own caret a frame or two after focus; re-collapse to the
      // end so we win the race without ever showing a selection.
      requestAnimationFrame(() => caretToEnd(input));
      setTimeout(() => caretToEnd(input), 60);
      // No beforeinput (old WebKit): fall back to select-all so typing still
      // replaces rather than prepends.
      if (!HAS_BEFOREINPUT) {
        setTimeout(() => { try { input.setSelectionRange(0, input.value.length); } catch { /* noop */ } }, 60);
      }
      return;
    }
    // Text field: only correct the caret when iOS parked it at 0 on a
    // non-empty value — never override a deliberate mid-text tap.
    requestAnimationFrame(() => {
      if (input.value && input.selectionStart === 0 && input.selectionEnd === 0) caretToEnd(input);
    });
  });

  if (replaceOnType && HAS_BEFOREINPUT) {
    input.addEventListener('beforeinput', (e) => {
      if (!pristine) return;
      pristine = false;
      if (e.inputType !== 'insertText' || !input.value) return;
      e.preventDefault();
      input.value = e.data == null ? '' : e.data;
      caretToEnd(input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Any edit that isn't the first insert (backspace, paste) ends pristine
    // mode, so the rest of the entry behaves like a normal field.
    input.addEventListener('input', () => { pristine = false; });
  }

  // Enter always commits and dismisses — every caller treats blur as the
  // commit point, so this keeps one code path.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  return input;
}

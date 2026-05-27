// Carbonyl runs us in a chromium build whose key forwarding only populates
// `windows_key_code` for a handful of special keys (arrows, backspace). For
// every other key, the page receives a keydown with `e.key === ''`, zero
// keyCode, and zero charCode -- which the rest of the codebase can't act on
// because all bindings live on `e.key`. The paired keypress event still
// carries the ASCII code, so we swallow the broken keydown and, on the
// keypress that follows, dispatch a synthetic keydown with a proper key
// field. Downstream handlers stay unchanged.
//
// In any real browser keydown always carries either key or keyCode, so the
// detection condition (`e.key === '' && e.keyCode === 0`) never matches and
// the shim is a no-op. Safe to install unconditionally.
;(function () {
  const KEY_NAMES = {
    8:  'Backspace',
    9:  'Tab',
    13: 'Enter',
    27: 'Escape',
    32: ' ',
  }
  // Submit chord: carbonyl's chromium fork doesn't forward Ctrl/Meta
  // modifiers, and single-byte options (Ctrl+J, etc.) collide with common
  // tmux prefix bindings in real-world setups. So we use a typed double-
  // tap of `;` instead: two `;` keypresses within SUBMIT_CHORD_MS_WINDOW
  // are recognised as the submit chord, the first inserted `;` is undone,
  // and a synthetic Enter-with-ctrl is dispatched so editor handlers that
  // listen for `e.key === 'Enter' && e.ctrlKey` (e.g. slop's "Add
  // comment" submit) fire as if the user had pressed Cmd/Ctrl+Enter.
  const SUBMIT_CHORD_CODE = 59 // ';'
  const SUBMIT_CHORD_MS_WINDOW = 400
  let lastChordTime = 0
  let pendingTarget = null
  function isBroken(e) {
    return !e.__cbShim && e.key === '' && e.keyCode === 0 && e.which === 0
  }
  // Capture-phase listener so we swallow the broken event before any page
  // handler sees it. We keep the original target around so the synthetic
  // keydown can be dispatched from the same node, which preserves
  // bubble-path handlers (textarea-scoped editor shortcuts, etc.).
  document.addEventListener('keydown', (e) => {
    if (isBroken(e)) {
      pendingTarget = e.target || document
      e.stopImmediatePropagation()
    }
  }, true)
  document.addEventListener('keypress', (e) => {
    if (!pendingTarget) return
    const target = pendingTarget
    pendingTarget = null
    const code = e.keyCode || e.which || e.charCode
    if (!code) return

    // Submit chord detection: second `;` within the window. The first `;`
    // has already been inserted at the caret by the previous keypress's
    // default action, so we splice it back out before dispatching the
    // synthetic Enter+ctrl.
    if (code === SUBMIT_CHORD_CODE) {
      const now = Date.now()
      if (lastChordTime && now - lastChordTime <= SUBMIT_CHORD_MS_WINDOW) {
        lastChordTime = 0
        e.preventDefault()
        const ae = document.activeElement
        const ta = (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) ? ae : null
        if (ta && typeof ta.selectionStart === 'number') {
          const pos = ta.selectionStart
          if (pos > 0 && ta.value.charAt(pos - 1) === ';') {
            ta.value = ta.value.slice(0, pos - 1) + ta.value.slice(pos)
            ta.setSelectionRange(pos - 1, pos - 1)
          }
        }
        // Dispatch synthetic Enter+ctrl so the editor's keydown shortcut
        // and any other Cmd/Ctrl+Enter listener gets a chance to fire.
        const submitTarget = ta || target || document
        const submit = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', ctrlKey: true,
          bubbles: true, cancelable: true,
        })
        submit.__cbShim = true
        submitTarget.dispatchEvent(submit)
        return
      }
      lastChordTime = now
    } else {
      lastChordTime = 0
    }

    const key = KEY_NAMES[code] || String.fromCharCode(code)
    const ev = new KeyboardEvent('keydown', {
      key,
      code: KEY_NAMES[code]
        ? KEY_NAMES[code]
        : (key.length === 1 && /[a-zA-Z]/.test(key) ? 'Key' + key.toUpperCase() : ''),
      bubbles: true,
      cancelable: true,
    })
    ev.__cbShim = true
    target.dispatchEvent(ev)
    // If a page handler called preventDefault on the synthetic keydown,
    // mirror it onto the original keypress so the browser doesn't follow
    // through with the character's default action (text insertion, etc.).
    // Otherwise leave the keypress alone so plain typing into inputs
    // still works.
    if (ev.defaultPrevented) e.preventDefault()
  }, true)
  document.addEventListener('keyup', (e) => {
    if (isBroken(e)) e.stopImmediatePropagation()
  }, true)

  // ----- Keymap-hint flatten (carbonyl-only) -----------------
  // Carbonyl text-emit drops every glyph after the first when
  // the hint bar uses nested inline-flex items (a chain of
  // `<span><kbd>j</kbd><kbd>k</kbd><span>move</span></span>`
  // wrappers). No pure-CSS workaround restores them; even a
  // pseudo-element `content:` string with all real children
  // display:none rendered as a single character.
  // Workaround, gated on the `is-carbonyl` class so a real
  // browser never sees it: after every render of the hint bar
  // (slop calls `hint.innerHTML = ...` whenever the cursor moves
  // or modes change), walk the items, build a flat text string,
  // and replace the bar's children with that one text node plus
  // <span class="cb-key"> wrappers around each key character.
  // A single inline run with no nested inline-flex boxes survives
  // carbonyl's rasterization intact.
  const HINT_SEL = '.diff-keymap-hint'
  const FLAT_MARK = 'data-cb-flat'
  function isCarbonyl () {
    return document.documentElement.classList.contains('is-carbonyl')
  }
  function flattenHint (hint) {
    if (!hint || hint.hidden) return
    if (hint.getAttribute(FLAT_MARK) === '1') return
    const items = hint.querySelectorAll('.diff-keymap-item')
    if (items.length === 0) return
    // Build a flat fragment with span-wrapped key characters so
    // the keys can be accent-tinted while the labels stay ink.
    // The whole bar is `position: fixed` (see carbonyl.css); that
    // detaches it into its own paint layer in the carbonyl
    // compositor, which is what lets the row of inline glyphs
    // emit fully instead of dropping after the first. Without
    // position:fixed, even a flat text node would lose every
    // glyph past the leftmost; with it, span-wrapped keys round-
    // trip too.
    const frag = document.createDocumentFragment()
    items.forEach((item, idx) => {
      if (idx > 0) frag.appendChild(document.createTextNode('   '))
      const keys = [...item.querySelectorAll('kbd')]
      keys.forEach((kbd, ki) => {
        if (ki > 0) frag.appendChild(document.createTextNode('/'))
        const span = document.createElement('span')
        span.className = 'cb-key'
        span.textContent = kbd.textContent
        frag.appendChild(span)
      })
      const label = item.querySelector('.diff-keymap-label')?.textContent || ''
      if (label) frag.appendChild(document.createTextNode(' ' + label))
    })
    // Tag before swapping so the observer reentry early-exits.
    hint.setAttribute(FLAT_MARK, '1')
    hint.replaceChildren(frag)
  }
  function installHintObserver () {
    if (!isCarbonyl()) return
    const main = document.getElementById('main') || document.body
    // Observe the slop main container for the hint bar appearing
    // and for content swaps. childList catches the initial render,
    // subtree catches inner innerHTML updates that slop performs.
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target.matches?.(HINT_SEL)) {
          m.target.removeAttribute(FLAT_MARK)
          flattenHint(m.target)
          continue
        }
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue
          const hint = node.matches?.(HINT_SEL) ? node : node.querySelector?.(HINT_SEL)
          if (hint) flattenHint(hint)
        }
      }
    })
    obs.observe(main, { childList: true, subtree: true })
    // Initial flatten in case the bar was already rendered (and
    // the hidden attribute is the only thing in our way).
    flattenHint(document.querySelector(HINT_SEL))
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installHintObserver, { once: true })
  } else {
    installHintObserver()
  }
})()

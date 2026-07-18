// Zero-dependency terminal widgets for the CLI. slop-review ships no runtime
// deps, so rather than pull in prompts/enquirer we drive stdin bytes in raw
// mode for the checkbox and lean on readline for the single-line input.
//
// Both widgets require a TTY on stdin and stdout. Callers check isTTY before
// reaching here; the guards below fail loudly so a piped invocation never
// sprays escape codes into whatever is consuming stdout.

import { createInterface } from 'node:readline'

export const PROMPT_CANCELLED = Symbol('slop-review:prompt-cancelled')

const CSI = '\x1b['
const HIDE_CURSOR = `${CSI}?25l`
const SHOW_CURSOR = `${CSI}?25h`
const CLEAR_DOWN = `${CSI}0J`

/**
 * Split a raw stdin chunk into individual key tokens. One 'data' event can
 * carry several keypresses (coalesced reads, fast typing, paste), so exact
 * whole-chunk matching drops keys. CSI (`ESC [`) and SS3 (`ESC O`) escape
 * sequences become a single token each (arrow keys etc.), consumed through
 * their final letter so an unknown sequence is emitted whole and ignored
 * rather than mis-read as separate keys. Everything else is one char.
 */
export function tokenizeKeys(chunk) {
  const tokens = []
  let i = 0
  while (i < chunk.length) {
    const c = chunk[i]
    if (c === '\x1b' && (chunk[i + 1] === '[' || chunk[i + 1] === 'O')) {
      let j = i + 2
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j++
      tokens.push(chunk.slice(i, j + 1))
      i = j + 1
    } else if (c === '\x1b') {
      i += 1   // lone ESC mid-chunk: ambiguous, drop (bare-ESC cancel is handled upstream)
    } else {
      tokens.push(c)
      i += 1
    }
  }
  return tokens
}

/**
 * Multi-select checkbox. Resolves to an array of the checked choices' `value`
 * (guaranteed non-empty), or PROMPT_CANCELLED on Esc / Ctrl+C / q.
 *
 * choices: [{ value, label, suffix?, checked? }]
 *
 * The in-place repaint assumes each rendered line fits the terminal width — a
 * wrapped line would throw off the "move up N lines" math. Labels here are
 * short (tool name + version), so we accept that rather than track wrapping.
 */
export function multiSelect({ message, choices, hint }) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    const output = process.stdout
    if (!input.isTTY || !output.isTTY) {
      reject(new Error('multiSelect requires an interactive terminal'))
      return
    }

    const items = choices.map((c) => ({ ...c, checked: !!c.checked }))
    let cursor = 0
    let painted = 0
    let settled = false

    const compose = () => {
      const lines = [message]
      items.forEach((item, i) => {
        const active = i === cursor
        const pointer = active ? `${CSI}36m>${CSI}0m` : ' '
        const box = item.checked ? `${CSI}32m[x]${CSI}0m` : '[ ]'
        const label = active ? `${CSI}36m${item.label}${CSI}0m` : item.label
        const suffix = item.suffix ? ` ${CSI}2m${item.suffix}${CSI}0m` : ''
        lines.push(`${pointer} ${box} ${label}${suffix}`)
      })
      if (hint) lines.push(`${CSI}2m${hint}${CSI}0m`)
      return lines
    }

    // Move to the top-left of the previously drawn block and clear downward
    // before writing. Cursor moves are relative, so this stays correct even
    // when drawing the block scrolled the viewport.
    const rewind = () => {
      if (painted === 0) return
      output.write('\r')
      if (painted > 1) output.write(`${CSI}${painted - 1}A`)
      output.write(CLEAR_DOWN)
    }

    const paint = () => {
      const lines = compose()
      rewind()
      output.write(lines.join('\n'))
      painted = lines.length
    }

    const cleanup = () => {
      input.removeListener('data', onData)
      try { input.setRawMode(false) } catch {}
      input.pause()
      rewind()          // erase the interactive block; caller prints the outcome
      painted = 0
      output.write(SHOW_CURSOR)
    }

    const cancel = () => {
      settled = true
      cleanup()
      resolve(PROMPT_CANCELLED)
    }

    // Returns true once the prompt is settled so the chunk loop stops feeding
    // it further keys.
    const handleKey = (key) => {
      if (key === '\x03' || key === 'q') { cancel(); return true }   // Ctrl+C / q
      if (key === `${CSI}A` || key === '\x1bOA' || key === 'k') {    // up (CSI + SS3 + vim)
        cursor = (cursor - 1 + items.length) % items.length
        paint()
      } else if (key === `${CSI}B` || key === '\x1bOB' || key === 'j') {   // down
        cursor = (cursor + 1) % items.length
        paint()
      } else if (key === ' ') {
        items[cursor].checked = !items[cursor].checked
        paint()
      } else if (key === 'a') {   // toggle all; turns everything off only when all are on
        const next = !items.every((it) => it.checked)
        for (const it of items) it.checked = next
        paint()
      } else if (key === '\r' || key === '\n') {
        if (!items.some((it) => it.checked)) return false   // require >=1, mirrors the web picker
        settled = true
        cleanup()
        resolve(items.filter((it) => it.checked).map((it) => it.value))
        return true
      }
      return false
    }

    const onData = (chunk) => {
      if (settled) return
      // A bare ESC (the whole chunk) is cancel; an ESC that leads a longer
      // chunk is an escape sequence, handled by the tokenizer below.
      if (chunk === '\x1b') { cancel(); return }
      // One 'data' event can carry several keypresses — coalesced reads, fast
      // typing, or a paste. Split into individual key tokens so none are
      // dropped (an early bug: `\x1b[B ` = down+space arrived as one chunk).
      for (const key of tokenizeKeys(chunk)) {
        if (handleKey(key)) return
      }
    }

    output.write(HIDE_CURSOR)
    input.setEncoding('utf8')
    try {
      input.setRawMode(true)
    } catch (e) {
      output.write(SHOW_CURSOR)
      reject(e)
      return
    }
    input.resume()
    input.on('data', onData)
    paint()
  })
}

/**
 * Single-line text input via readline. Resolves to the entered string (which
 * may be empty), or PROMPT_CANCELLED on Ctrl+C. Kept separate from the
 * checkbox so line editing (backspace, paste, kill-line) comes from readline
 * for free instead of being reimplemented in raw mode.
 */
export function promptLine({ message, initial = '' }) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // rl.close() on SIGINT does NOT fire the question callback, so cancellation
    // has to resolve from here.
    const onSigint = () => {
      rl.close()
      resolve(PROMPT_CANCELLED)
    }
    rl.on('SIGINT', onSigint)
    rl.question(message, (answer) => {
      rl.removeListener('SIGINT', onSigint)
      rl.close()
      resolve(answer)
    })
    if (initial) rl.write(initial)
  })
}

// ----------------------------------------------------------------------
// Minimal terminal control for the TUI: alternate screen, raw-mode stdin,
// cursor, and a clean teardown that always restores the terminal. v1 repaints
// the visible region per frame (no cell-diffing yet); that lands in a later
// milestone once interaction is richer.
// ----------------------------------------------------------------------
const ESC = '\x1b'
const { stdin, stdout } = process

export function enterAltScreen() {
  stdout.write(`${ESC}[?1049h`) // enter alternate screen buffer
  stdout.write(`${ESC}[?25l`)   // hide cursor
}

export function leaveAltScreen() {
  stdout.write(`${ESC}[?25h`)   // show cursor
  stdout.write(`${ESC}[?1049l`) // leave alternate screen buffer
}

export function enableRaw() {
  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.resume()
}

export function disableRaw() {
  if (stdin.isTTY) stdin.setRawMode(false)
  stdin.pause()
}

export function size() {
  return { rows: stdout.rows || 24, cols: stdout.columns || 80 }
}

// home cursor + clear to end of screen; cheaper than a full 2J each frame.
export function frameStart() {
  return `${ESC}[H`
}
export function clearToEol() {
  return `${ESC}[K`
}

// Copy text to the system clipboard via OSC52, which works over SSH and in
// most modern terminals without a clipboard helper binary. Wrapped in tmux
// passthrough when running inside tmux so the escape reaches the outer
// terminal. Best-effort: terminals that don't support OSC52 silently ignore.
export function osc52(text) {
  const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64')
  let seq = `${ESC}]52;c;${b64}\x07`
  if (process.env.TMUX) seq = `${ESC}Ptmux;${ESC}${seq.replace(/\x1b/g, '\x1b\x1b')}${ESC}\\`
  stdout.write(seq)
}

// ----------------------------------------------------------------------
// TUI entry point. Read + review diff views in the terminal, in-process via
// the shared core (the SAME data + mutations the browser drives over HTTP):
// view switching across the commit/Full/Local index space, a cursor over
// navigable diff rows, inline review threads, and the create/reply/resolve/
// delete loop. No HTTP server is started.
// ----------------------------------------------------------------------
import { spawn } from 'node:child_process'
import {
  loadFullDiff, loadCommitDiff, loadLocalDiff,
  listThreads, createThread, replyThread, setThreadResolved, removeThread,
  getReviewed, setReviewed, forgeUrlForLine, findSymbol, getLines, headPreview,
  overviewStatus, generateOverview, shutdownAllOverviewJobs,
} from '../core/actions.js'
import { getBranchInfo, getCommits } from '../server/git.js'
import { parsePatch } from '../core/patch.js'
import { tokenize, languageForPath } from '../core/syntax.js'
import { relTime } from '../core/format.js'
import {
  enterAltScreen, leaveAltScreen, enableRaw, disableRaw, size, frameStart, clearToEol, osc52,
} from './screen.js'
import { buildDiffLines } from './diff-view.js'
import { tokensToSgr } from './sgr.js'

const ESC = '\x1b'
const { stdin, stdout } = process
const ACCENT = `${ESC}[38;5;75m`
const FG_DEFAULT = `${ESC}[39m`
const DIM_FG = `${ESC}[38;5;244m`
const BOLD = `${ESC}[1m`
const RESET = `${ESC}[0m`
const CURSOR_BAR = String.fromCharCode(0x2590)
const CARET = String.fromCharCode(0x2588)
const sanitizeText = (s) => String(s ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ')

export async function run({ repoPath, serveUrl } = {}) {
  let info
  let commits = []
  try {
    info = await getBranchInfo(repoPath)
    if (info.merge_base_sha && info.head_sha) {
      commits = await getCommits(repoPath, info.merge_base_sha, info.head_sha)
    }
  } catch (e) {
    process.stderr.write(`slop-review --tui: ${e?.message || 'failed to read branch'}\n`)
    process.exit(1)
  }

  const views = [
    ...commits.map((c, i) => ({ kind: 'commit', sha: c.sha, label: `commit ${i + 1}/${commits.length}: ${(c.subject || c.sha).slice(0, 40)}` })),
    { kind: 'full', label: 'Full diff (cumulative)' },
    { kind: 'local', label: 'Local (working copy)' },
  ]
  let vi = views.length - 1

  let diff = { files: [], branch: info.current_branch }
  let threads = []
  let reviewed = new Set()
  let expanded = new Map() // `${file}#${hunkIdx}` -> { lines: [{oldNo,newNo,text}] }
  let wrap = false
  let showGutter = true
  let lines = []
  let navList = []
  let cursor = 0
  let top = 0
  let loadErr = ''
  let flash = ''
  let mode = 'nav'           // 'nav' | 'visual' | 'editor' | 'confirm'
  let editor = null          // { kind:'comment'|'reply', buffer, nav?, threadId?, range?, side? }
  let confirm = null         // { msg, onYes }
  let selAnchor = null       // { path, side, line } when in visual mode
  let prompt = null          // { label, buffer, onSubmit } when in prompt mode
  let panel = null           // { title, lines } when in panel mode (symbol def)
  let panelTop = 0
  let ov = null              // overview status object when in overview mode
  let ovTop = 0
  let ovPoll = null          // setInterval handle while an overview job runs
  let tornDown = false

  const contentRows = () => Math.max(1, size().rows - 1)
  const maxTop = () => Math.max(0, lines.length - contentRows())
  const cursorThreadIds = () => lines[cursor]?.nav?.threadIds || []
  const threadById = (id) => threads.find((t) => t.id === id)

  const rebuild = (anchor) => {
    lines = buildDiffLines(diff, size().cols, { threads, reviewed, expanded, wrap, showGutter })
    navList = []
    for (let i = 0; i < lines.length; i++) if (lines[i].nav) navList.push(i)
    if (anchor) {
      const found = navList.find((i) => {
        const n = lines[i].nav
        return n.path === anchor.path && n.side === anchor.side &&
          (n.side === 'old' ? n.oldNo : n.newNo) === anchor.line
      })
      cursor = found ?? (navList[0] ?? 0)
    } else {
      cursor = navList[0] ?? 0
    }
    ensureVisible()
  }

  const loadView = async () => {
    const v = views[vi]
    loadErr = ''
    try {
      diff =
        v.kind === 'commit' ? await loadCommitDiff(repoPath, v.sha) :
        v.kind === 'full'   ? await loadFullDiff(repoPath) :
                              await loadLocalDiff(repoPath)
    } catch (e) {
      loadErr = e?.message || 'failed to load diff'
      diff = { files: [], branch: info.current_branch }
    }
    expanded = new Map() // hunk indices are per-view; drop expansions on switch
    rebuild()
  }

  const reloadThreads = async (anchor) => {
    try { threads = await listThreads(repoPath) } catch { /* keep current */ }
    rebuild(anchor)
  }

  const anchorOf = () => {
    const n = lines[cursor]?.nav
    return n ? { path: n.path, side: n.side, line: n.side === 'old' ? n.oldNo : n.newNo } : undefined
  }

  const ensureVisible = () => {
    const cr = contentRows()
    if (cursor < top) top = cursor
    else if (cursor >= top + cr) top = cursor - cr + 1
    if (top > maxTop()) top = maxTop()
    if (top < 0) top = 0
  }

  const moveCursor = (delta) => {
    if (!navList.length) return
    let idx = navList.indexOf(cursor)
    if (idx < 0) { idx = navList.findIndex((i) => i >= cursor); if (idx < 0) idx = navList.length - 1 }
    idx = Math.max(0, Math.min(navList.length - 1, idx + delta))
    cursor = navList[idx]
    ensureVisible()
  }

  const jumpThread = (dir) => {
    if (!navList.length) return
    const withThreads = navList.filter((i) => lines[i].nav.threadIds.length)
    if (!withThreads.length) { flash = 'no threads in this view'; return }
    const ahead = dir > 0 ? withThreads.find((i) => i > cursor) : [...withThreads].reverse().find((i) => i < cursor)
    cursor = ahead ?? (dir > 0 ? withThreads[0] : withThreads[withThreads.length - 1])
    ensureVisible()
  }

  const teardown = (code = 0) => {
    if (tornDown) return
    tornDown = true
    if (ovPoll) { try { clearInterval(ovPoll) } catch {} ovPoll = null }
    // Kill any in-flight codex/claude overview child so it cannot orphan onto
    // the shared TTY after we leave the alternate screen.
    try { shutdownAllOverviewJobs() } catch {}
    try { leaveAltScreen(); disableRaw() } catch {}
    process.exit(code)
  }

  const render = () => {
    const { rows, cols } = size()
    if (mode === 'overview') {
      const st = ov || { status: 'idle' }
      const body = overviewBody(st, cols)
      let buf = frameStart()
      buf += `${ESC}[7m Branch Overview · ${st.status} ${clearToEol()}${ESC}[0m\r\n`
      const cr = rows - 2
      for (let i = 0; i < cr; i++) { const ln = body[ovTop + i]; buf += (ln != null ? ln : '') + clearToEol() + '\r\n' }
      buf += `${ESC}[7m g generate · r regenerate · j/k scroll · Esc close ${clearToEol()}${ESC}[0m`
      stdout.write(buf)
      return
    }
    if (mode === 'panel') {
      let buf = frameStart()
      buf += `${ESC}[7m ${panel.title} ${clearToEol()}${ESC}[0m\r\n`
      const cr = rows - 2
      for (let i = 0; i < cr; i++) {
        const ln = panel.lines[panelTop + i]
        buf += (ln != null ? ln : '') + clearToEol() + '\r\n'
      }
      const pct = panel.lines.length ? Math.round(Math.min(100, (panelTop + cr) / panel.lines.length * 100)) : 100
      buf += `${ESC}[7m symbol def · ${pct}%   j/k scroll · Esc close ${clearToEol()}${ESC}[0m`
      stdout.write(buf)
      return
    }
    const ed = mode === 'editor' ? editorRegion(cols) : []
    const cr = Math.max(1, rows - 1 - ed.length)
    const sel = selectionRange()
    let buf = frameStart()
    for (let i = 0; i < cr; i++) {
      const li = top + i
      const line = lines[li]
      const navHere = line && line.nav
      const isCursor = li === cursor && navHere && (mode === 'nav' || mode === 'visual')
      const inSel = sel && navHere && inSelection(line.nav, sel)
      const prefix = (isCursor || inSel) ? `${ACCENT}${CURSOR_BAR}${FG_DEFAULT}` : ' '
      buf += prefix + (line ? line.text : '') + clearToEol() + '\r\n'
    }
    for (const r of ed) buf += r + clearToEol() + '\r\n'
    buf += bottomLine(cols)
    stdout.write(buf)
  }

  const editorRegion = (cols) => {
    const title = editor.kind === 'reply' ? 'Reply'
      : editor.range ? `Comment lines ${editor.range.lo}-${editor.range.hi} (${editor.side})`
      : `Comment line ${editor.line} (${editor.side})`
    const body = editor.buffer.length ? editor.buffer.split('\n') : ['']
    const shown = body.slice(-8)
    const out = [`${DIM_FG}${'-'.repeat(Math.min(Math.max(0, cols - 1), 50))} ${title}${RESET}`]
    for (let i = 0; i < shown.length; i++) {
      out.push(`  ${shown[i]}${i === shown.length - 1 ? CARET : ''}`)
    }
    return out
  }

  const selectionRange = () => {
    if (mode !== 'visual' || !selAnchor) return null
    const cur = lines[cursor]?.nav
    const curLine = cur ? (selAnchor.side === 'old' ? cur.oldNo : cur.newNo) : selAnchor.line
    const b = curLine ?? selAnchor.line
    return { path: selAnchor.path, side: selAnchor.side, lo: Math.min(selAnchor.line, b), hi: Math.max(selAnchor.line, b) }
  }
  const inSelection = (nav, sel) => {
    if (nav.path !== sel.path || nav.side !== sel.side) return false
    const ln = sel.side === 'old' ? nav.oldNo : nav.newNo
    return ln != null && ln >= sel.lo && ln <= sel.hi
  }

  const bottomLine = (cols) => {
    if (mode === 'editor') {
      const hint = `Ctrl-S / Ctrl-D submit · Enter newline · Esc cancel`
      return `${ESC}[7m ${hint} ${clearToEol()}${ESC}[0m`
    }
    if (mode === 'prompt') {
      return `${ESC}[7m ${prompt.label}: ${prompt.buffer}${CARET}   Enter confirm · Esc cancel ${clearToEol()}${ESC}[0m`
    }
    if (mode === 'confirm') {
      return `${ESC}[7m${ESC}[38;5;167m ${confirm.msg} ${ESC}[39m${clearToEol()}${ESC}[0m`
    }
    if (mode === 'visual') {
      const sel = selectionRange()
      const rng = sel ? `${sel.lo}-${sel.hi} (${sel.side})` : ''
      return `${ESC}[7m ${ESC}[38;5;179mVISUAL ${rng}${ESC}[39m  j/k extend · c comment · Esc cancel ${clearToEol()}${ESC}[0m`
    }
    const v = views[vi]
    const navPos = navList.length ? `${navList.indexOf(cursor) + 1}/${navList.length}` : '0/0'
    const left = loadErr
      ? `${ESC}[38;5;167m${loadErr}${ESC}[39m`
      : flash
        ? `${ESC}[38;5;179m${flash}${ESC}[39m`
        : `${v.label} · ${diff.files?.length || 0} files · ${threads.length} threads · line ${navPos}`
    flash = ''
    const keys = `[ ]view·jk·v sel·c/a comment·r reviewed·x resolve·d del·e expand·o forge·* sym·y copy·b overview·n thread·q quit`
    return `${ESC}[7m ${left}  ${keys} ${clearToEol()}${ESC}[0m`
  }

  // ---- actions -------------------------------------------------------
  const openComment = (range) => {
    const n = lines[cursor]?.nav
    if (!n && !range) { flash = 'move the cursor to a diff line first'; return render() }
    const side = range ? range.side : n.side
    const line = range ? range.lo : (n.side === 'old' ? n.oldNo : n.newNo)
    const path = range ? range.path : n.path
    editor = { kind: 'comment', buffer: '', path, side, line, range: range && range.hi > range.lo ? { lo: range.lo, hi: range.hi } : null }
    mode = 'editor'; render()
  }
  const openCommentOldSide = () => {
    const n = lines[cursor]?.nav
    if (!n) { flash = 'move the cursor to a diff line first'; return render() }
    if (n.oldNo == null) { flash = 'this row has no old side'; return render() }
    editor = { kind: 'comment', buffer: '', path: n.path, side: 'old', line: n.oldNo, range: null }
    mode = 'editor'; render()
  }
  const openReply = () => {
    const ids = cursorThreadIds()
    if (!ids.length) { flash = 'no thread on this line (press c to start one)'; return render() }
    editor = { kind: 'reply', buffer: '', threadId: ids[0] }
    mode = 'editor'; render()
  }
  const submitEditor = async () => {
    const text = editor.buffer.trim()
    const isComment = editor.kind === 'comment'
    const anchor = isComment ? { path: editor.path, side: editor.side, line: editor.line } : anchorOf()
    mode = 'nav'
    if (!text) { editor = null; flash = 'empty comment discarded'; return render() }
    try {
      if (isComment) {
        threads = await createThread(repoPath, {
          view: views[vi].kind,
          file: editor.path,
          line: editor.line,
          lineEnd: editor.range ? editor.range.hi : null,
          side: editor.side,
          sha: diff.sha || null,
          body: text,
        })
        flash = editor.range ? 'multi-line comment posted' : 'comment posted'
      } else {
        threads = await replyThread(repoPath, editor.threadId, text)
        flash = 'reply posted'
      }
    } catch (e) {
      flash = `failed: ${e?.message || 'error'}`
    }
    editor = null
    rebuild(anchor)
    render()
  }
  const toggleResolve = async () => {
    const id = cursorThreadIds()[0]
    if (!id) { flash = 'no thread on this line'; return render() }
    const t = threadById(id)
    const anchor = anchorOf()
    try {
      threads = await setThreadResolved(repoPath, id, !t?.resolved_at)
      flash = t?.resolved_at ? 'thread reopened' : 'thread resolved'
    } catch (e) { flash = `failed: ${e?.message || 'error'}` }
    rebuild(anchor)
    render()
  }
  const askDelete = () => {
    const id = cursorThreadIds()[0]
    if (!id) { flash = 'no thread on this line'; return render() }
    const anchor = anchorOf()
    confirm = {
      msg: 'delete this thread? (y / n)',
      onYes: async () => {
        try { threads = await removeThread(repoPath, id); flash = 'thread deleted' }
        catch (e) { flash = `failed: ${e?.message || 'error'}` }
        rebuild(anchor)
      },
    }
    mode = 'confirm'; render()
  }
  const fileOf = () => lines[cursor]?.nav?.path || lines[cursor]?.file?.path || null
  const toggleReviewed = async () => {
    if (views[vi].kind === 'local') { flash = 'reviewed marks apply to Full/commit views (local has no stable blob)'; return render() }
    const path = fileOf()
    if (!path) { flash = 'move the cursor to a file first'; return render() }
    const anchor = anchorOf()
    const next = new Set(reviewed)
    if (next.has(path)) next.delete(path); else next.add(path)
    try {
      const r = await setReviewed(repoPath, [...next], { mode: 'replace' })
      reviewed = new Set(r.paths)
      flash = reviewed.has(path) ? `marked reviewed: ${path}` : `unmarked: ${path}`
    } catch (e) { flash = `failed: ${e?.message || 'error'}` }
    rebuild(anchor)
    render()
  }
  const loadReviewed = async () => {
    try { reviewed = new Set((await getReviewed(repoPath)).paths) } catch { /* keep */ }
  }
  const openForge = async () => {
    const n = lines[cursor]?.nav
    if (!n) { flash = 'move the cursor to a diff line first'; return render() }
    try {
      const url = await forgeUrlForLine(repoPath, { path: n.path, line: n.side === 'old' ? n.oldNo : n.newNo, side: n.side })
      if (!url) { flash = 'no PR / unsupported forge for this branch'; return render() }
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
      try { const ch = spawn(cmd, args, { stdio: 'ignore', detached: true }); ch.on('error', () => {}); ch.unref() } catch {}
      flash = `opened ${url}`
    } catch (e) { flash = `failed: ${e?.message || 'error'}` }
    render()
  }
  const copyLineRef = (oldSide) => {
    const n = lines[cursor]?.nav
    if (!n) { flash = 'move the cursor to a diff line first'; return render() }
    const side = oldSide ? 'old' : n.side
    const no = side === 'old' ? n.oldNo : n.newNo
    if (no == null) { flash = `this row has no ${side} side`; return render() }
    const ref = `${n.path}:${no}${side === 'old' ? ' (old)' : ''}`
    osc52(ref)
    flash = `copied: ${ref}`
    render()
  }
  const expandContext = async () => {
    const nav = lines[cursor]?.nav
    if (!nav || nav.hunkIdx == null) { flash = 'move the cursor to a diff line first'; return render() }
    const file = (diff.files || []).find((f) => f.path === nav.path)
    if (!file) return render()
    const hunks = parsePatch(file.patch || '')
    const h = hunks[nav.hunkIdx]
    if (!h) return render()
    const key = `${nav.path}#${nav.hunkIdx}`
    const existing = expanded.get(key) || { lines: [] }
    const curTop = existing.lines.length ? existing.lines[0].newNo : h.newStart
    const prevEnd = nav.hunkIdx > 0 ? (hunks[nav.hunkIdx - 1].newStart + hunks[nav.hunkIdx - 1].newLines - 1) : 0
    const end = curTop - 1
    const start = Math.max(prevEnd + 1, end - 19)
    if (end < 1 || start > end) { flash = 'no more context above this hunk'; return render() }
    const ref = views[vi].kind === 'local' ? 'WORKTREE' : (diff.sha || 'HEAD')
    const anchor = anchorOf()
    try {
      const out = await getLines(repoPath, ref, nav.path, start, end)
      if (out.missing || out.binary) { flash = 'cannot expand (missing/binary file)'; return render() }
      const fetched = (out.lines || []).map((text, i) => {
        const newNo = start + i
        const oldNo = h.oldStart - (h.newStart - newNo)
        return { newNo, oldNo: oldNo >= 1 ? oldNo : null, text }
      })
      expanded.set(key, { lines: [...fetched, ...existing.lines] })
      flash = `expanded ${fetched.length} lines`
    } catch (e) { flash = `failed: ${e?.message || 'error'}` }
    rebuild(anchor)
    render()
  }
  const openSymbolPrompt = () => {
    prompt = { label: 'Find symbol definition', buffer: '', onSubmit: doSymbol }
    mode = 'prompt'; render()
  }
  const peekHead = async () => {
    if (views[vi].kind !== 'commit') { flash = 'HEAD peek is for commit views'; return render() }
    const n = lines[cursor]?.nav
    if (!n || n.newNo == null) { flash = 'move to a new-side line in a commit view'; return render() }
    flash = 'peeking HEAD...'; render()
    try {
      const r = await headPreview(repoPath, views[vi].sha, n.path, n.newNo)
      if (r.status === 'file-deleted') { flash = `${n.path} is deleted at HEAD`; return render() }
      if (r.status === 'binary') { flash = 'binary file at HEAD'; return render() }
      const lang = languageForPath(n.path)
      const out = [`${DIM_FG}${n.path} at HEAD  (commit line ${n.newNo} maps to ${r.head_line}, ${r.status})${RESET}`, '']
      const start = r.start || 1
      ;(r.lines || []).forEach((ln, i) => {
        const no = start + i
        const isTarget = no === r.head_line
        const bar = isTarget ? `${ACCENT}${CURSOR_BAR}${FG_DEFAULT}` : ' '
        out.push(`${bar}${isTarget ? ACCENT : DIM_FG}${String(no).padStart(5)}${FG_DEFAULT}  ${tokensToSgr(tokenize(ln, lang))}`)
      })
      panel = { title: `HEAD: ${n.path}:${r.head_line ?? n.newNo}`, lines: out }
      panelTop = 0
      mode = 'panel'
    } catch (e) { flash = `failed: ${e?.message || 'error'}` }
    render()
  }
  const doSymbol = async (name) => {
    mode = 'nav'; prompt = null
    const sym = name.trim()
    if (!sym) return render()
    flash = `looking up ${sym}...`; render()
    try {
      const r = await findSymbol(repoPath, sym)
      if (!r || !r.found) { flash = `no definition found for ${sym}`; return render() }
      const lang = languageForPath(r.path)
      const out = [`${DIM_FG}${r.is_def ? 'definition' : 'first match'} in ${r.path}:${r.line}${RESET}`, '']
      const start = r.snippet?.start || 1
      ;(r.snippet?.lines || []).forEach((ln, i) => {
        const no = start + i
        const isDef = no === r.line
        const numFg = isDef ? ACCENT : DIM_FG
        const bar = isDef ? `${ACCENT}${CURSOR_BAR}${FG_DEFAULT}` : ' '
        out.push(`${bar}${numFg}${String(no).padStart(5)}${FG_DEFAULT}  ${tokensToSgr(tokenize(ln, lang))}`)
      })
      panel = { title: `${sym}  ${r.path}:${r.line}`, lines: out }
      panelTop = 0
      mode = 'panel'
    } catch (e) { flash = `failed: ${e?.message || 'error'}` }
    render()
  }

  const manageOvPoll = () => {
    if (ov && ov.status === 'generating' && !ovPoll) {
      ovPoll = setInterval(async () => {
        try { ov = await overviewStatus(repoPath) } catch {}
        if (!ov || ov.status !== 'generating') { clearInterval(ovPoll); ovPoll = null }
        if (mode === 'overview') render()
      }, 1500)
    } else if ((!ov || ov.status !== 'generating') && ovPoll) {
      clearInterval(ovPoll); ovPoll = null
    }
  }
  const openOverview = async () => {
    mode = 'overview'; ovTop = 0
    try { ov = await overviewStatus(repoPath) } catch (e) { ov = { status: 'error', error: e?.message || 'failed' } }
    manageOvPoll(); render()
  }
  const doGenerateOverview = async (force) => {
    try { ov = await generateOverview(repoPath, { force }) } catch (e) { ov = { status: 'error', error: e?.message || 'failed' } }
    manageOvPoll(); render()
  }
  const overviewBody = (st, cols) => {
    const w = Math.max(20, cols - 2)
    if (st.status === 'idle') {
      return ['', `  ${DIM_FG}No overview generated yet.${RESET}`,
        `  ${DIM_FG}tools: ${(st.available_tools || []).join(', ') || 'none available'}${RESET}`, '',
        st.can_generate ? '  press g to generate' : `  ${ESC}[38;5;167m${st.reason || 'cannot generate on this branch'}${RESET}`]
    }
    if (st.status === 'generating') {
      return ['', `  ${ESC}[38;5;179mGenerating branch overview...${RESET}`,
        `  ${DIM_FG}started ${relTime(st.started_at)} · Esc leaves (generation keeps running)${RESET}`]
    }
    if (st.status === 'error') {
      return ['', `  ${ESC}[38;5;167moverview generation failed${RESET}`, '',
        ...String(st.error || '').split('\n').map((l) => '  ' + sanitizeText(l).slice(0, w))]
    }
    const out = []
    if (st.status === 'stale') out.push(`  ${ESC}[38;5;179m[OUT OF DATE]  press r to regenerate${RESET}`, '')
    for (const raw of String(st.content || '').split('\n')) {
      const line = sanitizeText(raw).slice(0, w)
      out.push(/^#{1,6}\s/.test(line) ? `${BOLD}${line.replace(/^#+\s*/, '')}${RESET}` : line)
    }
    return out
  }

  // ---- boot ----------------------------------------------------------
  enterAltScreen()
  enableRaw()
  await loadView()
  await loadReviewed()
  await reloadThreads()
  if (serveUrl) flash = `also serving at ${serveUrl} (attach a browser/agent)`

  stdout.on('resize', () => { rebuild(anchorOf()); render() })

  stdin.on('data', (data) => {
    const s = data.toString('utf8')

    if (mode === 'editor') {
      if (s === ESC) { mode = 'nav'; editor = null; return render() }
      if (s[0] === ESC) return // ignore arrow / other escape sequences while typing
      for (const ch of s) {
        if (ch === '\x13' || ch === '\x04') { submitEditor(); return } // Ctrl-S / Ctrl-D submit
        else if (ch === '\r' || ch === '\n') editor.buffer += '\n'      // Enter inserts a newline
        else if (ch === '\x7f' || ch === '\x08') editor.buffer = editor.buffer.slice(0, -1)
        else if (ch >= ' ') editor.buffer += ch
      }
      return render()
    }

    if (mode === 'confirm') {
      if (s === 'y' || s === 'Y') { const f = confirm.onYes; confirm = null; mode = 'nav'; Promise.resolve(f()).then(render) }
      else { confirm = null; mode = 'nav'; flash = 'cancelled'; render() }
      return
    }

    if (mode === 'visual') {
      if (s === ESC) { mode = 'nav'; selAnchor = null; return render() }
      if (s === `${ESC}[A`) { moveCursor(-1); return render() }
      if (s === `${ESC}[B`) { moveCursor(1); return render() }
      for (const ch of s) {
        if (ch === '\x03') return teardown(0)
        else if (ch === 'j') moveCursor(1)
        else if (ch === 'k') moveCursor(-1)
        else if (ch === 'J') moveCursor(5)
        else if (ch === 'K') moveCursor(-5)
        else if (ch === 'c' || ch === '\r' || ch === '\n') { const sel = selectionRange(); mode = 'nav'; selAnchor = null; return sel ? openComment(sel) : render() }
        else if (ch === 'v' || ch === 'q') { mode = 'nav'; selAnchor = null }
      }
      return render()
    }

    if (mode === 'prompt') {
      if (s === ESC) { mode = 'nav'; prompt = null; return render() }
      if (s[0] === ESC) return
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') { return prompt.onSubmit(prompt.buffer) }
        else if (ch === '\x7f' || ch === '\x08') prompt.buffer = prompt.buffer.slice(0, -1)
        else if (ch >= ' ') prompt.buffer += ch
      }
      return render()
    }

    if (mode === 'overview') {
      if (s === ESC || s === 'q') { mode = 'nav'; if (ovPoll) { clearInterval(ovPoll); ovPoll = null } return render() }
      if (s === `${ESC}[A`) { ovTop = Math.max(0, ovTop - 1); return render() }
      if (s === `${ESC}[B`) { ovTop += 1; return render() }
      for (const ch of s) {
        if (ch === '\x03') return teardown(0)
        else if (ch === 'j') ovTop += 1
        else if (ch === 'k') ovTop = Math.max(0, ovTop - 1)
        else if (ch === 'g') return doGenerateOverview(false)
        else if (ch === 'r') return doGenerateOverview(true)
      }
      return render()
    }

    if (mode === 'panel') {
      if (s === ESC || s === 'q') { mode = 'nav'; panel = null; return render() }
      if (s === `${ESC}[A`) { panelTop = Math.max(0, panelTop - 1); return render() }
      if (s === `${ESC}[B`) { panelTop = Math.min(Math.max(0, panel.lines.length - 1), panelTop + 1); return render() }
      for (const ch of s) {
        if (ch === '\x03') return teardown(0)
        else if (ch === 'j') panelTop = Math.min(Math.max(0, panel.lines.length - 1), panelTop + 1)
        else if (ch === 'k') panelTop = Math.max(0, panelTop - 1)
      }
      return render()
    }

    // nav mode
    if (s === '[' || s === `${ESC}[1;2D`) { if (vi > 0) { vi--; loadView().then(render) } return }
    if (s === ']' || s === `${ESC}[1;2C`) { if (vi < views.length - 1) { vi++; loadView().then(render) } return }
    if (s === `${ESC}[A`) { moveCursor(-1); return render() }
    if (s === `${ESC}[B`) { moveCursor(1); return render() }
    for (const ch of s) {
      if (ch === 'q' || ch === '\x03') return teardown(0)
      else if (ch === 'j') moveCursor(1)
      else if (ch === 'k') moveCursor(-1)
      else if (ch === 'J') moveCursor(5)
      else if (ch === 'K') moveCursor(-5)
      else if (ch === 'g') { cursor = navList[0] ?? 0; ensureVisible() }
      else if (ch === 'G') { cursor = navList[navList.length - 1] ?? 0; ensureVisible() }
      else if (ch === 'n') jumpThread(1)
      else if (ch === 'N') jumpThread(-1)
      else if (ch === 'c') return openComment()
      else if (ch === 'C') return openCommentOldSide()
      else if (ch === 'v') { const n = lines[cursor]?.nav; if (n) { selAnchor = { path: n.path, side: n.side, line: n.side === 'old' ? n.oldNo : n.newNo }; mode = 'visual'; return render() } flash = 'move to a diff line first' }
      else if (ch === 'a') return openReply()
      else if (ch === 'x') return toggleResolve()
      else if (ch === 'd') return askDelete()
      else if (ch === 'r') return toggleReviewed()
      else if (ch === 'o') return openForge()
      else if (ch === '*') return openSymbolPrompt()
      else if (ch === 'y') return copyLineRef(false)
      else if (ch === 'Y') return copyLineRef(true)
      else if (ch === 'e') return expandContext()
      else if (ch === 'p') return peekHead()
      else if (ch === 'b') return openOverview()
      else if (ch === 'w') { wrap = !wrap; rebuild(anchorOf()); flash = `wrap ${wrap ? 'on' : 'off'}` }
      else if (ch === '#') { showGutter = !showGutter; rebuild(anchorOf()); flash = `line numbers ${showGutter ? 'on' : 'off'}` }
      else if (ch === '\x04') { top = Math.min(maxTop(), top + Math.floor(contentRows() / 2)); snapCursorIntoView() }
      else if (ch === '\x15') { top = Math.max(0, top - Math.floor(contentRows() / 2)); snapCursorIntoView() }
    }
    render()
  })

  function snapCursorIntoView() {
    const cr = contentRows()
    if (cursor < top || cursor >= top + cr) {
      const inView = navList.find((i) => i >= top && i < top + cr)
      if (inView != null) cursor = inView
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => teardown(0))
  process.on('uncaughtException', (e) => {
    try { shutdownAllOverviewJobs() } catch {}
    try { leaveAltScreen(); disableRaw() } catch {}
    process.stderr.write(`slop-review --tui crashed: ${e?.stack || e}\n`)
    process.exit(1)
  })

  render()
  await new Promise(() => {})
}

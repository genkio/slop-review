# slop-review

[![npm version](https://img.shields.io/npm/v/slop-review)](https://www.npmjs.com/package/slop-review)
[![npm downloads](https://img.shields.io/npm/dm/slop-review)](https://www.npmjs.com/package/slop-review)
[![node](https://img.shields.io/node/v/slop-review)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![website](https://img.shields.io/badge/website-genkio.github.io-5b6cff)](https://genkio.github.io/slop-review/)

**English** · [简体中文](./README.zh.md) · [日本語](./README.ja.md)

Local PR-review loop for you and your LLM. Run it in any git repo: leave inline comments on the diff, then hand the threads to an LLM (Claude Code, Cursor, Codex, etc.) acting as reviewer or reviewee via the bundled skill. Comments are JSON files under `<repo>/.reviews/` - no clipboard handoff, no running server required for the agent loop.

One diff page: pick the full branch diff, the local working-copy diff, or any single commit. Threads and the LLM-generated branch overview both open as modals from the header. Agent replies land in the JSON directly - refresh or reopen a thread to see them.

# Demo

https://github.com/user-attachments/assets/3058c57d-74b0-4bba-9c99-73cca13925f0

## Highlights

- **Blob-keyed "reviewed" marks, with HEAD peek.** Click a file header to mark it reviewed (also collapses it). The mark is keyed to that file's blob SHA at marking time, so a later push that touches *one* file invalidates only its mark - every untouched file stays green. Marking from a per-commit view is gated to "no later changes", so you never sign off on content you weren't looking at. When the gate fires, `p` peeks the file at HEAD without leaving the commit view - a focused window centered on your cursor line, walked through the commit-to-HEAD diff so intervening edits don't drift you off it.

- **Importance-ordered files in every diff.** Both the full diff and per-commit diffs sort files by how central they are to the change set: incoming reference count (how many *other changed files* import this one), then status (modified before added before removed), then source-before-support (source files before tests, docs, fixtures, changesets, and config/data files like JSON / YAML / TOML or lockfiles), then path. You land on the load-bearing edits first instead of alphabetical noise. Ported from [pi-slopchop](https://github.com/robzolkos/pi-slopchop) PR #2.

- **LLM-in-the-loop via a bundled skill.** The Claude Code skill at `skills/slop-review/SKILL.md` lets an agent play reviewer (leave inline comments) or reviewee (address open threads, edit source, reply) by reading and writing the `.reviews/` JSON directly - no HTTP integration.

- **Three diff modes, one page.** Full diff (cumulative vs base), any single commit, or the local working-copy diff. `Shift+←` / `Shift+→` steps between them; comments work in all three.

- **Cross-file symbol panel with multi-search parking.** Double-click any identifier in the diff to list every occurrence across changed files, active row highlighted in-place. Open a second symbol and the first parks into a right-edge strip - match list and jump history preserved - so you can pivot between concurrent searches without losing context. Esc parks; click a parked strip to restore.

- **Vim keybindings with a context-aware hint bar.** Single-letter verbs drive line-level actions (comment, copy, deep-link, delete) without leaving the keyboard. A which-key hint bar reveals on the first keypress and re-renders on every state change, showing only the keys live for the current cursor row and mode. Hidden hints are strict no-ops, so the bar never advertises a dead key.

- **Terminal-only review via Carbonyl.** `--carbonyl` (short: `-c`) renders the diff UI straight into the TTY via [Carbonyl](https://github.com/fathyb/carbonyl), a Chromium fork that paints into the terminal, so the whole loop stays in one pane beside your editor and agent - no browser, no context switch. Every keybinding carries over (a shim covers the few modifier chords Carbonyl strips). See [Carbonyl integration](#carbonyl-integration).

- **One-way GitHub review-thread sync.** `slop-review --sync` pulls the *unresolved* review threads from the current branch's GitHub PR into local threads on the full diff, keeping each GitHub author. Re-running mirrors GitHub: new replies flow in, threads resolved on GitHub are deleted locally, and any thread you've edited / replied-to / resolved locally is flagged so your edits stay put - new GitHub replies still append, but your work is never overwritten or re-ordered. See [GitHub review-thread sync](#github-review-thread-sync).

## Getting started

```bash
cd /path/to/your-feature-branch
npx slop-review
```

The cwd is auto-bootstrapped as the review target, the server picks a free port (range 9410-9419, then any free port), and your browser opens. Threads live in `<repo>/.reviews/` - add it to that repo's `.gitignore` to keep them local-only.

All flags are optional:

| Flag         | Alias | Argument   | Description                                                                                                   |
|--------------|-------|------------|---------------------------------------------------------------------------------------------------------------|
| `--port`     | `-p`  | `<n>`      | Port to bind. Default: first free in `9410-9419`, then any free port                                          |
| `--host`     |       | `<h>`      | Hostname to bind. Default `0.0.0.0`                                                                            |
| `--no-open`  |       |            | Don't auto-open the browser                                                                                   |
| `--carbonyl` | `-c`  | `[<path>]` | Open in the [Carbonyl](#carbonyl-integration) terminal browser; bare resolves `carbonyl` from `PATH`, or pass a binary / dir |
| `--sync`     | `-s`  |            | Mirror unresolved GitHub PR review threads into local threads, then exit. Needs `gh`. See [sync](#github-review-thread-sync) |
| `--browser`  | `-b`  |            | Chain after `--sync` to open the UI in your default browser once the sync finishes                            |
| `--threads`  | `-t`  |            | Open straight into the thread walk (full diff, first unresolved thread surfaced) without syncing              |
| `--help`     | `-h`  |            | Show help                                                                                                     |

`--sync` exits after mirroring unless you chain `--browser`, `--carbonyl`, or `--threads` - those open the UI and keep re-syncing every 5 min. `--threads` reaches that same resume view without syncing.

Prerequisites: Node ≥ 20, `git` on `PATH`, and Python 3 when generating an Overview. No runtime dependencies - the server is `node:http` + the standard library only, so `npx slop-review` pulls no transitive packages.

The Overview modal uses the bundled `explain-diff-html` skill with `codex exec` or `claude` to generate a self-contained branch explainer with background, intuition, a code walkthrough, diagrams where useful, and an interactive quiz. The generator picker also accepts optional instructions such as “Explain it in both English and Chinese”; the skill turns requested languages into a complete multilingual reading mode. Generated HTML is cached under `.reviews/` and displayed in a sandboxed frame. When both CLIs are on `PATH` the modal lets you pick; when one is, it's a single-button confirm. Generation errors include the captured CLI output and a Retry button.

State lives at `~/.config/slop-review/state.json` (honors `XDG_CONFIG_HOME`): schema version plus per-repo UI state (last view + thread-resume cursors).

## What to expect

A couple of intentional behaviors that may surprise GitHub-review muscle memory.

### Where you land on launch

Cold launch first tries to resume the last view for this branch, then falls back to a per-commit default:

| Scenario                                              | Lands on                        |
|-------------------------------------------------------|---------------------------------|
| URL explicitly names a sha or `local`                 | Honored when it resolves (else falls through below) |
| Saved last view exists and still resolves             | Resumes that view               |
| Feature branch, commits ahead of base                 | First commit (oldest in branch) |
| On `main`/`master`, no commits ahead                  | Latest commit                   |
| On `main`/`master`, no commits ahead, has local edits | Unstaged view                   |
| Empty branch (no commits at all)                      | Full diff (degenerate fallback) |

Rationale: feature-branch review walks forward from base, so first-commit is the natural entry. The on-base path uses an empty-tree merge-base fallback that can synthesize the whole repo history, where the latest commit beats the dawn of the project. The full diff is always one `Shift+→` away.

### Resume

Each navigation (Shift+←/→, the nav buttons, or a fresh hash URL) stamps the current view under `state.config.repo_ui_state.<repoId>.last_view:<branchId>` as `full`, `local`, `local:<scope>`, or `commit:<sha>`. The next cold launch rehydrates it - unless the saved commit no longer exists (force-push, rebase, GC'd sha), in which case the smart-default table above kicks in. Per-branch scoping means switching branches never carries the wrong sha across.

Local changes extend the normal diff timeline: **Full diff → Staged → Unstaged**. The same previous/next buttons and `h`/`l` bindings walk through all three positions. Staged shows `HEAD` → index; Unstaged shows index → working tree plus the untracked-file banner. Both are bookmarkable at `#/diff/local/staged` and `#/diff/local/unstaged`, and the selected position is restored across launches.

## Carbonyl integration

slop-review runs in any browser, and also fully inside a terminal via [Carbonyl](https://github.com/fathyb/carbonyl) (a Chromium-based browser that paints into the TTY). `--carbonyl` launches it instead of your default GUI browser:

```bash
# Install once (macOS, prebuilt via the genkio/tap homebrew tap):
brew install genkio/tap/carbonyl

# Opt in per launch:
slop-review --carbonyl
```

Bare `--carbonyl` resolves the `carbonyl` binary from `PATH` (where the brew install puts it). For a dev build or custom install location, pass a binary or a directory containing one:

```bash
slop-review --carbonyl ~/code/carbonyl/dist
slop-review --carbonyl ~/code/carbonyl/dist/carbonyl
```

Carbonyl inherits the slop-review terminal, so you get a single-pane loop with no window switch. Quitting Carbonyl (Ctrl+C) tears the server down with it.

### Keybindings

The diff view is fully keyboard-driven. The same bindings work in a regular browser and in Carbonyl, except for the two modifier chords noted below: Carbonyl's Chromium fork strips Ctrl/Cmd/Shift before forwarding keydown, so any modifier binding needs a substitute.

| Key                   | Action                                             | Carbonyl                       |
|-----------------------|----------------------------------------------------|--------------------------------|
| `j` / `k`             | Move cursor down / up one line                     | yes                            |
| `J` / `K`             | Move cursor down / up five lines                   | yes                            |
| `c` / `C`             | Open comment editor on new-side / old-side line    | yes                            |
| `v` / `V`             | Start visual-line selection (new / old side)       | yes                            |
| `y` / `Y`             | Copy a `path:line` reference to the cursor line (new / old side) | yes               |
| `o` / `O`             | Open the cursor line in the forge (new / old side) | yes                            |
| `r`                   | Toggle the cursor row's file as reviewed           | yes                            |
| `n` / `N`             | Jump to next / previous thread in view             | yes                            |
| `d`                   | Delete the thread under the cursor                 | yes                            |
| `p`                   | Peek HEAD for the cursor row (commit view only)    | yes                            |
| `e`                   | Expand context lines around the cursor's hunk      | yes                            |
| `Enter`               | Commit visual-line selection / confirm modal       | yes                            |
| `Escape`              | Cancel selection, minimize panel, close modal      | yes                            |
| `Backspace`           | Pop the active symbol-panel jump-stack frame       | yes                            |
| `Cmd/Ctrl+Enter`      | Submit the comment editor                          | use `;;` instead               |
| `Shift+←` / `Shift+→` | Step to previous / next commit (or local / full)   | use the `‹` / `›` nav buttons  |
| `←` / `→`             | Previous / next thread inside the thread modal     | yes                            |

`;;` (two semicolons within 400ms while the editor is focused) is handled by `public/carbonyl-key-shim.js`: it detects the double-tap, splices the first `;` back out of the textarea, and dispatches a synthetic `Ctrl+Enter` so the existing submit handler (which keys off `Enter` with `metaKey` or `ctrlKey`) fires unchanged. The shim loads unconditionally but only triggers on Carbonyl's modifier-stripped event signature, so in a regular browser it's a no-op.

For a literal `;;` in a comment body, pause >400ms between the two characters (or type `; ;` with a space and edit it out).

## GitHub review-thread sync

`slop-review --sync` is a one-shot, one-directional mirror: it pulls the **unresolved** review threads from your branch's GitHub PR into local threads, then exits (no server, no browser). It uses the `gh` CLI for auth and data (GraphQL - the only place GitHub exposes thread *resolved* state), so `gh` must be installed and logged in. A non-GitHub origin or a branch with no open PR is a no-op.

```bash
slop-review --sync
```

Semantics:

- **Anchoring.** GitHub review threads live on the PR "Files" tab, so they land on slop's **full diff** (`view: "full"`). GitHub's `RIGHT` / `LEFT` maps to slop's `new` / `old`; multi-line ranges are kept. File-level comments (no line anchor) are reported as skipped.
- **Authorship.** Synced comments keep the GitHub author's login as `user`, the thread shows a **GitHub** badge, and each comment's timestamp links back to the original on GitHub.
- **Mirror on re-run.** Each sync refreshes existing synced threads (new replies appear), **deletes** local threads resolved on GitHub, and **creates** newly-opened ones.
- **Local edits win.** Edit, reply to, delete a comment from, or resolve a synced thread and it's flagged `locally_modified`; every later sync leaves your edits untouched, only **appending** any new GitHub replies - it never overwrites or re-orders your work. The badge goes muted to show it diverged.
- **One direction.** Sync never writes back to GitHub.
- **Open straight into review.** Chain `--browser` or `--carbonyl` (e.g. `slop-review --sync --browser`) to launch the UI when the sync finishes, landing on the full diff with the first unresolved thread's modal open. Plain `slop-review --sync` just prints the summary and exits.
- **Keeps mirroring while open.** When `--sync` opens the UI (chained with `--browser` / `--carbonyl` / `--threads`), the server re-syncs from GitHub every 5 minutes so new replies and resolutions keep flowing in. A **"Synced …"** badge in the diff header shows when the last pull landed (it renders in carbonyl too); a failed pull shows **"Sync failed"**. The loop runs in the server process, so quitting slop-review (Ctrl-C, in the terminal or the carbonyl pane) stops the pull with it. The page doesn't live-reload threads, so once a background sync has changed threads the badge appends **"· N behind"** (amber) to tell you a manual reload is worth it; reloading or navigating clears it.

Each run prints a summary: created / updated / deleted / skipped, plus the GitHub unresolved total.

## AI agent integration

slop-review ships a Claude Code skill at `skills/slop-review/SKILL.md` that teaches an agent to read threads, leave comments as reviewer, or address open threads as reviewee. It works directly on the `.reviews/` JSON - no HTTP API, no running server.

Two roles, either played by developer or LLM:

- **Reviewer** - leaves inline comments / questions on diff lines.
- **Reviewee** - addresses comments by editing source code + appending replies.

### Install

Via the [`skills`](https://www.npmjs.com/package/skills) npm package (Vercel Labs):

```bash
npx skills add genkio/slop-review
```

That copies `SKILL.md` into place for your agent CLI (Claude Code: `~/.claude/skills/slop-review/SKILL.md`). Then prompt naturally - *"act as reviewer for this slop-review branch"*, *"address the unresolved slop-review threads"* - and the LLM picks it up via auto-discovery.

### Contributor install (hot-iteration)

Editing the skill itself? Symlink it so changes take effect without re-running `npx skills add`:

```bash
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/slop-review" ~/.claude/skills/slop-review
```

Edits to `skills/slop-review/SKILL.md` in this checkout are now live on the next prompt. Remove with `rm ~/.claude/skills/slop-review`. (If you previously ran `npx skills add genkio/slop-review`, `rm -rf` the real directory at the install path first.)

## Development

```bash
git clone <this-repo> && cd slop-review
```

No dependencies. The HTTP layer (`server/http.js`) is a small in-house wrapper over `node:http` for routing, JSON, and static files; if you change it, exercise the full request surface manually - `npm test` covers diff/state logic only. Frontend (`public/**`) edits need only a hard refresh.

Test the real `npx slop-review` flow against an external repo:

```bash
cd /path/to/slop-review
npm link              # `slop-review` now points at this checkout
cd /some/target/repo
slop-review           # runs your local code against the cwd repo

# or run directly
node /path/to/slop-review/bin/slop-review.js
```

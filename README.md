# slop-review

A local PR-review loop for developer ↔ LLM. Run it inside any git repo to leave inline review comments on the diff, then ask an LLM (Claude Code, Cursor, Codex, etc.) to act as reviewer or reviewee via the bundled skill. Comments live as JSON files under `<repo>/.reviews/` — no GitHub API, no clipboard handoff, no running server required for agent workflows.

The UI is a single diff page: pick the full branch diff, the local working-copy diff, or any individual commit; threads and the LLM-generated branch overview both open as modals from the diff header. Agent replies land in the JSON files directly — refresh or reopen a thread to see them.

## Highlights

- **Per-file blob-keyed reviewed marks.** Click a file's header to mark it reviewed (also collapses it). The mark is keyed by the file's blob SHA at marking time, so a later push that modifies *that one file* silently invalidates only its mark — every untouched file stays green. Marking from a per-commit view is gated to "no later changes" (the file's blob at the commit must equal its blob at HEAD), so you never persist a sign-off against content you weren't actually looking at.
- **Importance-ordered files in every diff view.** Both the Full diff and per-commit diffs sort files by how central they are to the change set: how many *other changed files* import this one (reference count), then status (modified before added before removed), then source-vs-support (source files before tests / docs / fixtures), then path. You land on the structurally load-bearing edits first instead of alphabetical noise. Ported from [pi-slopchop](https://github.com/robzolkos/pi-slopchop) PR #2.
- **LLM-in-the-loop review via a bundled skill.** The Claude Code skill at `skills/slop-review/SKILL.md` lets an agent play reviewer (leave inline comments) or reviewee (address open threads, edit source, reply) without any HTTP integration — it reads and writes the JSON files in `<repo>/.reviews/` directly.
- **Three diff modes, one page.** Full diff (cumulative vs base), any individual commit, or the local working-copy diff — Shift+← / Shift+→ to step between them; comments are allowed in all three views.
- **Cross-file symbol panel with multi-search parking.** Double-click any identifier in the diff and a side panel opens listing every occurrence across changed files, with the active row highlighted in-place. Open a second symbol and the first session minimizes into a right-edge strip — its match list and jump history preserved — so you can pivot between two or three concurrent searches without losing context. Esc minimizes; click a parked strip to restore.
- **No GitHub round-trip.** Inline comments live as plain JSON under `<repo>/.reviews/`, so the whole review loop happens offline against your working tree. Add the directory to `.gitignore` to keep threads local, or commit it to share them with collaborators.

## Getting started

```bash
cd /path/to/your-feature-branch
npx slop-review
```

That's it. The cwd is auto-bootstrapped as the review target, the server picks a free port (default 4919), and your browser opens. Review threads are stored in `<repo>/.reviews/` — add it to that repo's `.gitignore` if you want them local-only.

Flags: `--port <n>`, `--host <h>`, `--no-open`, `-h`.

Prerequisites: Node ≥ 20, `git` on `PATH`. No runtime dependencies — the server runs on `node:http` + the standard library only, so `npx slop-review` doesn't pull a tree of transitive packages onto your machine.

The Overview modal uses `codex exec` in read-only non-interactive mode to generate a branch summary on demand. If `codex` is not on `PATH` or not logged in, the modal shows the captured CLI error and a retry button.

State (schema version only): `~/.config/slop-review/state.json`.

## What to expect

A couple of behaviors are intentional but might surprise readers coming from GitHub-style review tools.

### Where you land on launch

Cold-launching `npx slop-review` resolves a sensible per-commit default instead of opening the full cumulative diff:

| Scenario                                              | Lands on                        |
|-------------------------------------------------------|---------------------------------|
| Feature branch, commits ahead of base                 | First commit (oldest in branch) |
| On `main`/`master`, no commits ahead                  | Latest commit                   |
| On `main`/`master`, no commits ahead, has local edits | Local view                      |
| Empty branch (no commits at all)                      | Full diff (degenerate fallback) |
| URL explicitly names a sha or `local`                 | Honored as-is                   |

Rationale: feature-branch review is "walk forward from base", so first-commit is the natural entry. The on-base path uses an empty-tree merge-base fallback that can synthesize the whole repo history, where the latest commit is more useful than the dawn of the project. The Full diff is always a Shift+→ keystroke away from any commit view.

## AI agent integration

slop-review ships a Claude Code skill at `skills/slop-review/SKILL.md` that teaches the agent how to read review threads, leave new comments as a reviewer, or address open threads as a reviewee. The skill works directly with the JSON files in `<repo>/.reviews/` — no HTTP API, no running slop-review server required for agent work.

Two roles, both can be played by developer or LLM:

- **Reviewer** — leaves inline comments / asks questions on diff lines.
- **Reviewee** — addresses comments by editing source code + appending replies.

### End-user install

Install once via the [`skills`](https://www.npmjs.com/package/skills) npm package (Vercel Labs):

```bash
npx skills add genkio/slop-review
```

That fetches the repo and copies `SKILL.md` into the right location for whichever agent CLI you run (Claude Code: `~/.claude/skills/slop-review/SKILL.md`). After install, prompt naturally — *"act as reviewer for this slop-review branch"*, *"address the unresolved slop-review threads"* — and the LLM picks up the skill via auto-discovery.

### Contributor install (hot-iteration)

If you're editing the skill itself and want changes to take effect immediately without re-running `npx skills add`, symlink the local skill directory into your skills folder:

```bash
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/slop-review" ~/.claude/skills/slop-review
```

Now edits to `skills/slop-review/SKILL.md` in this checkout are live in Claude Code on the next prompt. Remove with `rm ~/.claude/skills/slop-review` when switching back to the published version. (If you previously ran `npx skills add genkio/slop-review`, that left a real directory at the install path — `rm -rf` it first before creating the symlink.)

## Development

```bash
git clone <this-repo> && cd slop-review
```

There are no dependencies, the HTTP layer (`server/http.js`) is a small in-house wrapper over `node:http` that handles routing, JSON, and static files. If you change it, exercise the full request surface manually before shipping; the test suite (`npm test`) covers diff/state logic only.

Frontend (`public/**`) edits don't need a restart — just hard-refresh the browser.

**Testing the actual `npx slop-review` flow against an external repo:**

```bash
cd /path/to/slop-review
npm link              # makes `slop-review` globally point at this checkout
cd /some/target/repo
slop-review           # runs your local code, picks up the cwd repo

# alternatively
node /path/to/slop-review/bin/slop-review.js
```


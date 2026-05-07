# slop-review

A local PR-review loop for human ↔ LLM. Run it inside any git repo to leave inline comments on your feature branch's diff, hand the threads off to Claude Code or Codex CLI via clipboard, and watch the agent's replies stream back over SSE.

## Getting started

```bash
cd /path/to/your-feature-branch
npx slop-review
```

That's it. The cwd is auto-bootstrapped as the review target, the server picks a free port (default 4919), and your browser opens. Review threads are stored in `<repo>/.reviews/` — add it to that repo's `.gitignore` if you want them local-only.

Flags: `--port <n>`, `--host <h>`, `--no-open`, `-h`.

Prerequisites: Node ≥ 20, `git` on `PATH`, `gh` authenticated (falls back to `me` if unreachable).

State (prompt templates + schema version): `~/.config/slop-review/state.json`.

## Development

```bash
git clone <this-repo> && cd slop-review
npm install
npm run dev    # watches server/**, restarts on save; reviews this checkout itself (cwd → SLOP_REVIEW_REPO)
```

Frontend (`public/**`) edits don't need a restart — just hard-refresh the browser.

**Testing the actual `npx slop-review` flow against an external repo:**

```bash
cd /path/to/slop-review
npm link              # makes `slop-review` globally point at this checkout
cd /some/target/repo
slop-review           # runs your local code, picks up the cwd repo
```

Reset state for a clean test: `rm ~/.config/slop-review/state.json`. Or sandbox it: `SLOP_REVIEW_STATE_FILE=/tmp/test.json slop-review`.

## Publishing

```bash
npm publish --dry-run   # verify the tarball contents (bin/, server/, public/, SPEC.md)
npm publish
```

The `files` array in `package.json` is the allowlist; `node_modules/`, `.reviews/`, and local state are never shipped.

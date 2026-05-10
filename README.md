# slop-review

A local PR-review loop for developer ↔ LLM. Run it inside any git repo to leave inline review comments on the diff, ask an LLM (Claude Code, Cursor, Codex, etc.) to act as reviewer or reviewee via the bundled skill, and watch replies stream back live over SSE. Comments live as JSON files under `<repo>/.reviews/` — no GitHub API, no clipboard handoff, no running server required for agent workflows.

## Getting started

```bash
cd /path/to/your-feature-branch
npx slop-review
```

That's it. The cwd is auto-bootstrapped as the review target, the server picks a free port (default 4919), and your browser opens. Review threads are stored in `<repo>/.reviews/` — add it to that repo's `.gitignore` if you want them local-only.

Flags: `--port <n>`, `--host <h>`, `--no-open`, `-h`.

Prerequisites: Node ≥ 20, `git` on `PATH`.

The Overview page uses `codex exec` in read-only non-interactive mode. If `codex` is not on `PATH` or not logged in, the page shows the captured CLI error and a retry button.

State (schema version only): `~/.config/slop-review/state.json`.

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
npm install
```

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


---
name: slop-review
description: Slop-review review-thread workflows on a git feature branch. TRIGGER only when the user explicitly names "slop-review" / "slop review" or references its artifacts (`<repo>/.reviews/`, `thread_*.json`). SKIP generic code-review prompts that don't name slop-review.
---

# slop-review skill

`slop-review` turns a git feature branch into a GitHub-PR-style review loop. Comments are JSON files in the repo: `<repo>/.reviews/<branch_id>/thread_<status>_<8hex>.json`. The web UI is for the **developer**; **you (the agent) edit the files directly** - no HTTP API, no running server needed.

Two roles per conversation:

- **Reviewer** - reads the diff, leaves inline comments / questions on specific lines.
- **Reviewee** - reads comments, answers, edits source code + appends replies.

Either role can be human or LLM. Same mechanics for both - pick the verb from the prompt.

---

## Where threads live

```
<repo>/.reviews/<branch_id>/thread_<status>_<8hex>.json
```

- **`<branch_id>`** - the branch name, `[^A-Za-z0-9_-]` collapsed to `-`, leading/trailing `-` stripped, capped at 80 chars:

  ```bash
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  BRANCH_ID=$(printf '%s' "$BRANCH" | sed -E 's/[^A-Za-z0-9_-]+/-/g; s/^-+//; s/-+$//' | cut -c1-80)
  ```

  Or just `ls <repo>/.reviews/` and pick the dir matching the branch - most repos have one or two.

- **`<status>`** ∈ `{open, resolved}`. **Act only on `thread_open_*.json`.** `thread_resolved_*` are closed; treat as read-only history.

- **`<8hex>`** - a stable random hex id; never changes when status flips.

Sidecars in the same dir:

- `_reviewed.json` - UI bookkeeping for per-file "reviewed" marks. **Ignore**; don't read or write.
- `_overview.json` - the branch overview the UI's Overview modal renders. You can author it; see [Workflow: generate the branch overview](#workflow-generate-the-branch-overview).

---

## Thread JSON shape

```jsonc
{
  "id":            "thread_a1b2c3d4",          // stable; matches the hex in the filename
  "view":          "full",                     // "commit" | "full" | "local"
  "file":          "packages/foo/src/bar.ts",  // the source file the comment anchors to
  "line":          42,                         // for side:"new", line in `file` at `sha`; for side:"old", line in `file` at the base revision (pre-image)
  "line_end":      null,                       // end line (inclusive) for multi-line anchors; null/equal-to-line = single line
  "side":          "new",                      // "old" = pre-image (deleted/base-revision lines), "new" = post-image (added/HEAD lines). Per-thread, not per-comment.
  "sha":           "abc123…",                  // commit SHA (commit view) or HEAD SHA at create time
  "anchor_text":   "  return result.empty ? null : result",  // line text snapshot at create time
  "created_at":    "2026-05-09T10:00:00Z",
  "last_read_at":  "2026-05-09T11:30:00Z",     // developer controls; don't touch
  "resolved_at":   null,                       // ISO timestamp when resolved; null = open. DON'T touch
  "github_thread_id": null,                    // (sync-only) GitHub GraphQL node id; present only on threads pulled in by `slop --sync`. DON'T touch
  "locally_modified": false,                   // (sync-only) true = sync leaves this thread alone. Web UI sets it; when YOU edit a synced thread's file directly you MUST set it yourself (see rules)
  "comments": [
    {
      "id":        "thread_a1b2c3d4_1",        // <thread.id>_<N>, where N is 1-indexed
      "user":      "reviewer",
      "body":      "should this handle the empty case?",
      "posted_at": "2026-05-09T10:00:00Z"
    },
    {
      "id":        "thread_a1b2c3d4_2",
      "user":      "reviewee",
      "body":      "Good catch - added a guard. See foo.ts:42.",
      "posted_at": "2026-05-09T10:15:00Z"
    }
  ]
}
```

**Field rules - both roles:**

- **Don't modify** `id`, `created_at`, `last_read_at`, `resolved_at`. Stable identifiers or developer-controlled state.
- **Don't rename the file.** Status (`_open_` ↔ `_resolved_`) is the developer's, set via the web UI. Renaming from the agent breaks their mental model.
- **`comments[]`** is append-only. Never mutate or reorder existing entries.
- **`line_end`** - `null` (or absent / equal to `line`) = single-line anchor; else the inclusive end line. The server caps the span at 500 lines.
- **`anchor_text`** - only modify when relocating an anchor onto a resolving commit (see the reviewee workflow).
- **`github_thread_id` (sync-only). Don't touch.** Set on threads `slop --sync` pulls from a GitHub PR's *unresolved* review threads. It's the GitHub GraphQL node id; sync matches on it across runs to decide create / refresh / delete, and its mere presence is what marks a thread "synced". Don't hand-edit or remove it. Synced comments carry the GitHub author's login as `user` (not the `reviewer` / `reviewee` role markers), anchor on `view: "full"`, and each carries a `github_url` permalink back to the comment on GitHub.
- **`locally_modified` (sync-only). YOU set it.** Synced thread = has `github_thread_id`.
  - `false` -> next `slop --sync` overwrites the thread from GitHub, or *deletes* it once it's resolved/gone upstream (may later re-create it under a fresh `thread_<hex>` filename). Your appended reply is silently LOST.
  - `true` -> sync skips it forever (never refreshed or deleted). Local edits win.

  The web UI flips it automatically, but **only for mutations made through the UI**. Editing the JSON file directly (this skill's whole premise) does NOT trip it, and marking-as-read never does. So whenever you append/edit a comment on, relocate the anchor of, or otherwise change a thread that has a `github_thread_id`, write `"locally_modified": true` in the same edit. Leave it absent on developer-authored threads (no `github_thread_id`), and never set it back to `false`.

- **`pr_level` (sync-only). Don't touch.** `true` on threads `slop --sync` creates from a GitHub review's top-level *summary body* (the text submitted with Approve / Comment / Request-changes), which has no line anchor. These carry `file: null` - the UI renders them "anchor lost" (surfaced in the thread nav, not pinned to a diff row) - and a `github_thread_id` that is the *review* node id. Reply to them like any synced thread (set `locally_modified`), but leave `file` null; don't invent an anchor.

---

## Workflow: as reviewer (leave new comments)

Prompt example: *"review this branch and leave inline comments on anything sketchy"*.

1. **Read the diff** for comment-worthy lines:
   ```bash
   BASE=$(git merge-base origin/HEAD HEAD 2>/dev/null || git merge-base origin/main HEAD)
   git diff "$BASE"..HEAD
   ```
   Per-commit: `git show <sha>`. Uncommitted: `git diff HEAD`.

2. **For each spot, write a thread JSON file:**

   - Thread id: `thread_<8 random hex>`. Fresh hex each time; don't reuse.
   - `anchor_text` = the literal source line at that point (no leading `+` / `-` from the diff). For `side: "old"` the line isn't in the working tree - read it from the diff's `-` half, or `git show "$BASE:$file" | sed -n '<line>p'`.
   - `sha`:
     - `view: "full"` -> `git rev-parse HEAD`
     - `view: "commit"` -> the full commit SHA you're reviewing
     - `view: "local"` -> literal string `"local"`
   - Write `<repo>/.reviews/<branch_id>/thread_open_<hex>.json` (substitute your values):
     ```jsonc
     {
       "id": "thread_<hex>",
       "view": "full",
       "file": "packages/foo/src/bar.ts",
       "line": 42,
       "line_end": null,             // or <end-line> for a multi-line range; omit / null for single line
       "side": "new",
       "sha": "<sha-from-above>",
       "anchor_text": "<line text>",
       "created_at": "<current UTC ISO 8601>",
       "last_read_at": "<same as created_at>",
       "resolved_at": null,
       "comments": [
         {
           "id": "thread_<hex>_1",
           "user": "reviewer",
           "body": "<your comment>",
           "posted_at": "<current UTC ISO 8601>"
         }
       ]
     }
     ```

3. **Pick `view`:**
   - `full` - branch-level review vs base (default).
   - `commit` - a specific commit; pair with that commit's SHA.
   - `local` - the user's uncommitted working-tree changes.

4. **`side`** - `"new"` unless commenting on a removed line, then `"old"`.

5. **`mkdir -p`** the branch dir first if missing:
   ```bash
   mkdir -p <repo>/.reviews/<branch_id>/
   ```

6. **Summarize where you commented** - list the file:line anchors. Don't restate each comment; the developer sees them in the UI.

**Issue outside the diff?** A change can surface a bug in code this PR doesn't touch (a caller, a config, a now-wrong test) - a finding with no `+`/`-` line to sit on. Anchor to the real `file`:`line` anyway: read the current line at HEAD for `anchor_text`, with `side: "new"` and `sha: <HEAD>`. slop renders it "anchor lost" (not pinned to a visible diff row) but still counts it and walks it in the thread nav, so the developer reaches it. Always prefer a real anchor when a relevant file exists - it hands the developer a coordinate they can open. A `file: null` thread (no anchor at all) is reserved for `slop --sync` mirroring a GitHub review *body*; don't hand-author one.

**On `user`:** every `user` value is a **role**, not a person's identity. Author as the role you play - `"reviewer"` when the prompt asks you to leave comments / questions, `"reviewee"` when it asks you to address a thread. Never your agent name (`claude`, `codex`, ...). The UI stamps developer comments `"reviewer"` automatically, so rendered authors are just the two role names.

---

## Workflow: as reviewee (address open threads)

Prompt example: *"go through unresolved slop-review threads and address them"*.

1. **List open threads** (resolved = out of scope):
   ```bash
   ls <repo>/.reviews/<branch_id>/thread_open_*.json
   ```

2. **For each open thread:**
   - **Read** the JSON. `comments[0]` = the original note anchored at `file`:`line`; later entries = prior replies.
   - **Resolve the anchor against HEAD first.** The thread's `file` / `line` / `anchor_text` describe what the reviewer saw at `sha`, not necessarily HEAD now. Later commits may have shifted, rewritten, or already fixed that line (especially `view: "commit"`). Before editing, find the current equivalent:
     - `grep -n "<anchor_text>" "<file>"` - where the line lives now (line numbers drift; the literal text is the durable anchor).
     - `git log -L <line>,<line>:<file> <sha>..HEAD` - what happened to that exact line between the thread's `sha` and HEAD.
     - If `anchor_text` is gone at HEAD and a later commit appears to have addressed the concern, **reply with that observation instead of re-fixing it** - don't restate work the developer already did.
   - **Open the source file at HEAD** (using the resolved line above) and decide whether a code change is still warranted.
   - **If yes - edit the source code**, then `git commit` with a conventional-commits subject (`fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `chore:`, ...) describing the resolution. **One commit per thread** by default; fold multiple threads into one commit only if they're truly the same edit.
   - **Relocate the thread's anchor onto the resolving commit** - edit these fields IN PLACE in the JSON:
     - `view` -> `"commit"`
     - `sha` -> the new commit's full SHA (`git rev-parse HEAD`)
     - `file` -> the most semantically-relevant file in the new commit's diff (usually the one you edited)
     - `line` -> the most relevant line in that file at the new SHA
     - `line_end` -> end line if the resolving change spans a range, else `null`. Don't carry over a stale multi-line range.
     - `anchor_text` -> the literal text of that line at the new SHA
   - **Append exactly one** entry to `comments[]`:
     ```jsonc
     {
       "id":        "<thread.id>_<N>",  // N = comments.length + 1, BEFORE you append
       "user":      "reviewee",          // the role you're playing - see "On `user`" above
       "body":      "Added a guard for the empty case. See abc1234.",
       "posted_at": "<current UTC ISO 8601>"
     }
     ```
     Reference the resolving commit's short SHA in `body` so the developer can find it.
   - **If the thread is synced** (it has a `github_thread_id`), **set `"locally_modified": true`** in this same write. Otherwise the next `slop --sync` overwrites the thread from GitHub (or deletes it) and your reply *and* anchor relocation are lost. Skip this for developer-authored threads (no `github_thread_id`).
   - **Write the JSON back** with **2-space indentation** preserved.
   - **Don't set `resolved_at`, don't rename the file.** Resolution is the developer's gesture - they review your commit + reply in the UI and click `✓ Resolve` if satisfied (the rename to `thread_resolved_*.json` happens server-side then).

3. **If a question needs no code** (e.g. a clarification request), just append a reply - no source edit, no commit.

4. **Summarize** - list the commits and which threads they addressed. Don't `git push` unless the user asks.

---

## Workflow: reply to a specific thread

Prompt example: *"reply to `thread_open_a1b2c3d4.json`"*.

1. **Find the file.** Named filename -> `<repo>/.reviews/<branch_id>/<filename>`. Otherwise:
   ```bash
   ls <repo>/.reviews/<branch_id>/thread_open_*.json   # if you have only the hex
   grep -l '"file": "packages/foo/src/bar.ts"' <repo>/.reviews/<branch_id>/thread_open_*.json   # by anchor
   ```

2. **Read**, then **append** one comment with `id: <thread.id>_<comments.length + 1>` and `user` = your role (`"reviewer"` for a follow-up question / observation, `"reviewee"` to answer or address the thread). **If the thread has a `github_thread_id` (synced from GitHub), also set `"locally_modified": true`** in the same write so the next sync doesn't overwrite your reply. Then **write back**, preserving indentation.

---

## Workflow: generate the branch overview

Prompt examples: *"generate the slop-review overview"*, or as a step in *"understand the changes, generate overview, then review"*. When asked for overview + review together, do the overview first - it's the warm-up that makes the line-level review better-targeted.

The UI's **Overview** modal renders `<repo>/.reviews/<branch_id>/_overview.json`. The CLI normally produces it; you can write the same artifact.

1. **Skip if nothing changed.** No commits ahead of base and no local changes -> tell the user and stop.

2. **Inspect** the diff in scope (`<merge-base>..HEAD` for committed work, `git diff HEAD` for local-only). Exclude `.reviews/`.

3. **Write the Markdown** with these headings, in this order. The UI looks sections up by **exact heading text**, so the names are load-bearing:

   ```
   # Overview
   ## What Changed
   ## Mental Model
   ## Before vs After Behavior
   ## Sketch       (fenced ```json``` block, shape below)
   ```

   Sketch shape: `{ "nodes": [{ "id": "...", "label": "...", "detail": "..." }], "edges": [["from", "to"]] }`. Small: ≈3-6 nodes, 2-7 edges; node ids are lowercase letters/digits/`_-`. The UI renders it as a diagram.

   Keep the prose concise and grounded in what the diff shows. For the exact CLI prompt (word counts, bullet caps, tone rules), read `buildOverviewPrompt` in `server/overview.js`.

4. **Compute `cache_key`** so the UI doesn't badge the overview "stale". SHA-1 over a `JSON.stringify` of this object, in this key order:

   ```js
   {
     prompt_version: 3,
     branch, base_sha, merge_base_sha, head_sha,   // null if unknown
     has_commits_ahead, has_local_changes,         // booleans
     local: null,                                  // see note below
   }
   ```

   When `has_local_changes` is true the server replaces `local: null` with a working-tree fingerprint (tracked diff SHA-1 + `[{path, size, mtime_ms}]` per untracked file). Reproducing it is fiddly - just leave `local: null` and accept the "stale" badge. Content still renders; regenerate is one click for the developer.

5. **Write atomically** (tmp file + `mv`) to `<repo>/.reviews/<branch_id>/_overview.json`:

   ```jsonc
   {
     "version": 1, "status": "ready",
     "cache_key": "<step 4>", "prompt_version": 3,
     "branch_id": "...", "branch": "...",
     "base_branch": "...", "base_sha": "...",
     "merge_base_sha": "...", "head_sha": "...",
     "has_local_changes": false,
     "started_at": "<UTC ISO>", "completed_at": "<UTC ISO>",
     "content": "<the Markdown from step 3>",
     "error": null
   }
   ```

6. Tell the user where it landed + a one-line takeaway. Don't paste the Markdown - the UI renders it. If they also asked for a review pass, continue into the reviewer workflow.

---

## Things to avoid

- **Don't touch `resolved_at`, don't rename `_open_*` -> `_resolved_*`.** Resolution status is developer-controlled via the web UI.
- **Don't act on `thread_resolved_*.json`.** They're closed; the conversation is done. (Read for historical context if asked; don't append to them or edit them.)
- **Don't delete `<repo>/.reviews/`** or the `_reviewed.json` sidecar - UI bookkeeping, not reversible. `_overview.json` is fair to (re)write under the overview workflow, but don't delete it.
- **Don't `git push`** unless the user explicitly asks. Resolutions are local commits by default.
- **Don't forget `locally_modified` on synced threads.** Editing a `github_thread_id` thread's file directly doesn't trip the web UI's auto-flip, so the next `slop --sync` silently overwrites (or even deletes and re-creates under a new filename) that thread and your appended reply is lost - unless you set `"locally_modified": true` yourself in the same write.
- **Don't fold multiple thread resolutions into one commit** unless they're literally the same edit. The default is one commit per thread; the UI's per-commit view (`#/diff/<sha>`) shows the original comment + reply + the resolving diff side by side, which is the whole point of the loop.
- **Don't synthesize replies the developer didn't ask for.** Asked to "find unresolved threads" -> just *list* them; don't append "I'll handle this" comments to each.
- **Don't impersonate the developer.** `user` = the **role** you're playing (`"reviewer"` / `"reviewee"`), never your agent's tool name (`claude`, `codex`, ...) or anything that reads like a person's name.

---

## Quick reference: minimal scaffolding

```bash
# Resolve where to write
REPO_ROOT=$(git rev-parse --show-toplevel)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
BRANCH_ID=$(printf '%s' "$BRANCH" | sed -E 's/[^A-Za-z0-9_-]+/-/g; s/^-+//; s/-+$//' | cut -c1-80)
THREADS_DIR="$REPO_ROOT/.reviews/$BRANCH_ID"
mkdir -p "$THREADS_DIR"

# List open threads
ls "$THREADS_DIR"/thread_open_*.json 2>/dev/null

# Generate a fresh thread id (8 hex)
NEW_HEX=$(openssl rand -hex 4)
NEW_ID="thread_$NEW_HEX"
NEW_FILE="$THREADS_DIR/thread_open_$NEW_HEX.json"
```

That's the entire surface area. Read, edit, write JSON files; commit code changes via `git`. The server reads the thread files fresh on each request, so the developer sees your edits on their next page load / navigation - there's no filesystem watcher and no live push, but also no notification step you need to trigger.

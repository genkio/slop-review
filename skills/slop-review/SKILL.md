---
name: slop-review
description: Slop-review review-thread workflows on a git feature branch. TRIGGER only when the user explicitly names "slop-review" / "slop review" or references its artifacts (`<repo>/.reviews/`, `thread_*.json`). SKIP generic code-review prompts that don't name slop-review.
---

# slop-review skill

`slop-review` is a local code-review surface that turns a git feature branch into a GitHub-PR-style review loop. Comments live as JSON files in the repo at `<repo>/.reviews/<branch_id>/thread_<status>_<8hex>.json`. The slop-review web UI is what the **developer** uses to view threads and mark them resolved; **you (the agent) work with the underlying files directly** — no HTTP API, no running server required.

There are two roles in any given conversation:

- **Reviewer** — reads the diff, leaves inline comments / questions on specific lines.
- **Reviewee** — reads existing comments, answers questions, and addresses feedback by editing source code + appending replies to the thread.

Either role can be a developer or an LLM. The skill works the same way for both — pick the verb from the user's prompt.

---

## Where threads live

```
<repo>/.reviews/<branch_id>/thread_<status>_<8hex>.json
```

- **`<branch_id>`** is the current branch name with `[^A-Za-z0-9_-]` collapsed to `-`, leading/trailing `-` stripped, capped at 80 chars. Compute it with:

  ```bash
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  BRANCH_ID=$(printf '%s' "$BRANCH" | sed -E 's/[^A-Za-z0-9_-]+/-/g; s/^-+//; s/-+$//' | cut -c1-80)
  ```

  In practice you can also just `ls <repo>/.reviews/` and pick the directory matching the current branch — most repos have one or two.

- **`<status>`** ∈ `{open, resolved}`. **Only act on `thread_open_*.json` files.** `thread_resolved_*.json` are closed; treat them as read-only history.

- **`<8hex>`** is a stable random hex id; never changes when status flips.

Sidecars (not threads, ignore): `_reviewed.json`, `_overview.json`.

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
      "body":      "Good catch — added a guard. See foo.ts:42.",
      "posted_at": "2026-05-09T10:15:00Z"
    }
  ]
}
```

**Field rules — both roles:**

- **Don't modify** `id`, `created_at`, `last_read_at`, `resolved_at`. They're either stable identifiers or developer-controlled state.
- **Don't rename the file.** Resolution status (`_open_` ↔ `_resolved_`) is developer-controlled via the slop-review web UI; touching it from the agent breaks the user's mental model.
- **`comments[]`** is append-only — never mutate or reorder existing entries.
- **`line_end`**: `null` (or absent / equal to `line`) for a single-line anchor; set to the inclusive end line for a multi-line range. The server caps the range at 500 lines.
- **`anchor_text`**: only modify when relocating an anchor onto a resolving commit (see the reviewee workflow below).

---

## Workflow: as reviewer (leave new comments)

User prompt example: *"review this branch and leave inline comments on anything sketchy"*.

1. **Read the diff** to find lines worth commenting on:
   ```bash
   BASE=$(git merge-base origin/HEAD HEAD 2>/dev/null || git merge-base origin/main HEAD)
   git diff "$BASE"..HEAD
   ```
   For per-commit review, use `git show <sha>`. For uncommitted changes, `git diff HEAD`.

2. **For each comment-worthy spot, write a thread JSON file**:

   - Generate a thread id: `thread_<8 random hex chars>`. Use a fresh hex each time; don't reuse.
   - Capture `anchor_text` from the source file at the line you're commenting on (the literal line text, no leading `+` / `-` from the diff). For `side: "old"`, the line won't exist in the working tree — read it from the diff's `-` half, or via `git show "$BASE:$file" | sed -n '<line>p'`.
   - Capture `sha`:
     - `view: "full"` → `git rev-parse HEAD` (current head)
     - `view: "commit"` → the full commit SHA you're reviewing
     - `view: "local"` → literal string `"local"`
   - Write the file at `<repo>/.reviews/<branch_id>/thread_open_<hex>.json` with this shape (substitute your values):
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

3. **Pick the right `view`**:
   - `full` for branch-level review (default — reviewing what the feature branch changes vs the base).
   - `commit` when commenting on a specific commit; pair with that commit's SHA.
   - `local` for the user's uncommitted working-tree changes.

4. **Choose `side: "new"`** unless you're specifically commenting on a removed line, in which case `side: "old"`.

5. **`mkdir -p`** the branch directory first if it doesn't exist:
   ```bash
   mkdir -p <repo>/.reviews/<branch_id>/
   ```

6. **Summarize where you commented** — list the file:line anchors. Don't restate what each comment said; the developer will see them in the slop-review UI.

**On `user`:** every comment's `user` value is a **role**, not a person's identity. When you (the agent) author a comment, set `user` to the role you're playing — `"reviewer"` if the user's prompt asks you to leave comments / questions, `"reviewee"` if the prompt asks you to address an existing thread. Don't use your agent name (`claude`, `codex`, etc.). The slop-review web UI follows the same convention: developer-authored comments are stamped `"reviewer"` automatically, so a thread's rendered author labels are just the two role names plus whatever you and the developer's counterparties choose.

---

## Workflow: as reviewee (address open threads)

User prompt example: *"go through unresolved slop-review threads and address them"*.

1. **List open threads** (resolved threads are out of scope):
   ```bash
   ls <repo>/.reviews/<branch_id>/thread_open_*.json
   ```

2. **For each open thread, in turn**:
   - **Read** the JSON. Index 0 of `comments[]` is the original note anchored at `Source:` (`file`:`line`); later entries are prior replies.
   - **Resolve the anchor against HEAD first.** The thread's `file` / `line` / `anchor_text` describe what the reviewer saw at `sha` — not necessarily what's at HEAD now. For `view: "commit"` (and to a lesser degree `view: "full"`), later commits may have shifted, rewritten, or already fixed that line. Before editing, locate the current equivalent at HEAD:
     - `grep -n "<anchor_text>" "<file>"` — find where the line lives now (line numbers drift; literal text is the more durable anchor).
     - `git log -L <line>,<line>:<file> <sha>..HEAD` — see what happened to that exact line between the thread's `sha` and HEAD.
     - If `anchor_text` no longer exists at HEAD and a later commit appears to have addressed the concern, **reply with that observation instead of re-fixing it** — don't restate work the developer already did.
   - **Open the source file at HEAD** (using the resolved line from the step above) and decide whether a code change is still warranted.
   - **If yes — edit the source code**, then `git commit` with a conventional-commits subject (`fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `chore:`, etc.) describing the resolution. **One commit per thread** by default; only fold multiple threads into one commit if they're truly the same edit.
   - **Relocate the thread's anchor onto the resolving commit** by editing these fields IN PLACE in the JSON:
     - `view` → `"commit"`
     - `sha` → the new commit's full SHA (`git rev-parse HEAD`)
     - `file` → path of the most semantically-relevant file in the new commit's diff (usually the file you edited)
     - `line` → line number of the most relevant line in that file at the new SHA
     - `line_end` → end line if the resolving change spans a range; otherwise `null`. Don't carry over a stale multi-line range from the original anchor.
     - `anchor_text` → the literal text of that line at the new SHA
   - **Append exactly one new entry** to `comments[]`:
     ```jsonc
     {
       "id":        "<thread.id>_<N>",  // N = comments.length + 1, BEFORE you append
       "user":      "reviewee",          // the role you're playing — see "On `user`" above
       "body":      "Added a guard for the empty case. See abc1234.",
       "posted_at": "<current UTC ISO 8601>"
     }
     ```
     Reference the resolving commit's short SHA in `body` so the developer can find it.
   - **Write the JSON back** with **2-space indentation** preserved.
   - **Don't set `resolved_at`** and **don't rename the file**. Resolution is the developer's gesture — they'll review your commit + reply in the UI and click `✓ Resolve` if satisfied. (The UI rename to `thread_resolved_*.json` happens server-side then.)

3. **If a question doesn't need code** (e.g. clarification request), just append a reply comment without editing source or committing.

4. **Summarize** — list the commits you made and which threads they addressed. Don't `git push` unless the user asks.

---

## Workflow: reply to a specific thread

User prompt example: *"reply to `thread_open_a1b2c3d4.json`"*.

1. **Find the file**. If the developer named the filename: `<repo>/.reviews/<branch_id>/<filename>`. Otherwise:
   ```bash
   ls <repo>/.reviews/<branch_id>/thread_open_*.json   # if you have only the hex
   # or grep for the file:line anchor:
   grep -l '"file": "packages/foo/src/bar.ts"' <repo>/.reviews/<branch_id>/thread_open_*.json
   ```

2. **Read** the JSON, **append** one comment with `id: <thread.id>_<comments.length + 1>` and `user` set to your current role — `"reviewer"` if the user asked you to leave a follow-up question / observation, `"reviewee"` if you're answering or addressing the existing thread — then **write back** preserving indentation.

---

## Things to avoid

- **Don't touch `resolved_at`** and **don't rename `_open_*` → `_resolved_*` files**. Resolution status is developer-controlled via the slop-review web UI.
- **Don't act on `thread_resolved_*.json` files**. They're closed; the conversation is done. (You can read them for historical context if asked, but don't append to them or edit them.)
- **Don't delete `<repo>/.reviews/`** or the `_reviewed.json` / `_overview.json` sidecars — those are the slop-review web UI's bookkeeping; nuking them isn't reversible.
- **Don't push to the remote** (`git push`) unless the user explicitly asks. Resolutions are local commits by default.
- **Don't fold multiple thread resolutions into one commit** unless they're literally the same edit. The default is one commit per thread; the slop-review UI's per-commit view (`#/diff/<sha>`) shows the original comment + reply + the resolving diff side by side, which is the whole point of the loop.
- **Don't synthesize replies the developer didn't ask for.** If asked "find unresolved threads", just *list* them — don't append "I'll handle this" comments to each one.
- **Don't impersonate the developer.** Set `user` to the **role** you're playing — `"reviewer"` when leaving comments, `"reviewee"` when addressing them — never to your agent's tool name (`claude`, `codex`, etc.) or to anything that could be mistaken for a person's name.

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

That's the entire surface area. Read, edit, write JSON files; commit code changes via `git`. The slop-review web UI picks up your changes in real time via filesystem watchers — no notification step needed.

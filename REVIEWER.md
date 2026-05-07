# Reviewer Notes

## For Reviewer

When reviewing a slop-review branch, prefer the app API for refetching code and thread state. The browser URL is the human-facing anchor, but the API is faster and less lossy for checking the current diff, replies, and branch context.

Useful endpoints:

- `GET /api/repos/:id/branch` for current branch, head, base, and merge-base context.
- `GET /api/repos/:id/commits` for the branch's commit list.
- `GET /api/repos/:id/commits/:sha/diff` for the diff of a specific resolving commit.
- `GET /api/repos/:id/diff` for the full branch diff.
- `GET /api/repos/:id/threads` for comments, replies, thread state, and relocated anchors.

### Initial Review

For an initial branch review, use:

- `/branch` to understand the current branch, base branch, and whether local changes exist.
- `/commits` to understand the branch shape and whether the review should focus on individual commits or the full diff.
- `/diff` to inspect the full branch diff.
- `/threads` to check whether any review discussion already exists.

Use the browser UI when you need to inspect layout or interaction behavior, or when you need to leave an inline review comment. When leaving feedback, add it as a slop-review thread or comment on the relevant diff line rather than only summarizing it in chat.

To create a review comment through the API instead of the browser UI:

```http
POST /api/repos/:id/threads
Content-Type: application/json
```

```json
{
  "view": "full",
  "file": "path/to/file.js",
  "line": 42,
  "side": "new",
  "sha": "<current diff sha>",
  "body": "Review comment text",
  "anchor_text": "optional line text snapshot"
}
```

Use `view: "full"` for full-branch review comments, `view: "commit"` for a specific commit diff, and `view: "local"` for local uncommitted changes. For commit comments, use the full commit SHA in `sha`.

### Follow-Up Review

If a thread was resolved by a commit, prefer reviewing the per-commit URL:

```text
#/diff/<sha>
```

Resolved threads should be relocated onto the commit that addressed them, so the per-commit view shows the original comment, the agent reply, and the resolving diff together.

Use `/commits/:sha/diff` plus `/threads` to refetch both the code change and the latest reply. Open the browser UI only if you need to verify the inline rendering or leave another comment.

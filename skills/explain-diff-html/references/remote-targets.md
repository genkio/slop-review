# Remote targets without checkout

Use this workflow when the user supplies a GitHub PR or remote branch while a
different branch—often `main` or `master`—is checked out. Keep the working tree
and current branch untouched.

## Explicit GitHub PR

In the commands below, `origin` means the local remote for the PR's base
repository. Verify it with `git remote -v`; if the repository uses another
remote name, substitute that name. Do not add or rewrite remotes merely for the
explanation.

1. Read PR identity and context:

   ```bash
   gh pr view <url-or-number> \
     --json number,title,body,url,headRefName,headRefOid,baseRefName,baseRefOid,comments
   ```

   Read inline review comments when they materially explain design evolution:

   ```bash
   gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate
   ```

2. If `HEAD` already equals `headRefOid`, use the checked-out branch diff. If
   not, fetch the PR head into the object database without creating or switching
   a branch:

   ```bash
   git fetch --no-tags origin "pull/<number>/head"
   PR_HEAD=$(git rev-parse FETCH_HEAD)
   ```

   Verify `PR_HEAD` matches the `headRefOid` observed from `gh pr view`. If the
   PR changed during analysis, refresh the metadata and consistently use the
   newly fetched head.

3. Ensure the PR base commit is available. Fetch the named base without
   checkout when needed, then use the PR's recorded `baseRefOid` when present:

   ```bash
   git cat-file -e "<baseRefOid>^{commit}" 2>/dev/null || \
     git fetch --no-tags origin "<baseRefName>"
   PR_BASE=<baseRefOid>
   ```

   If the recorded base OID is unavailable after fetching, derive the merge
   base from the fetched base tip and `PR_HEAD`, and state that fallback in the
   page.

4. Treat the three-dot diff as the source of truth:

   ```bash
   git diff "$PR_BASE...$PR_HEAD"
   git diff --stat "$PR_BASE...$PR_HEAD"
   git diff --name-status "$PR_BASE...$PR_HEAD"
   git log --oneline "$PR_BASE..$PR_HEAD"
   ```

   This works while `main`/`master` remains checked out. Do not fold in local
   `git diff` or `git diff --staged`; those changes belong to the current working
   tree, not the explicit PR target.

5. Inspect code from the correct tree. Plain `rg`, `sed`, or file reads address
   the checked-out branch and can silently show the wrong implementation.
   Instead use:

   ```bash
   git show "$PR_HEAD:path/to/changed-file"
   git show "$PR_BASE:path/to/changed-file"       # before behavior
   git grep -n "symbol-or-contract" "$PR_HEAD" -- path/to/area
   git ls-tree -r --name-only "$PR_HEAD"
   ```

   Use the same target-qualified reads for tests, callers, configuration,
   schemas, and documentation. When many related files are needed, selectively
   extract them with `git archive "$PR_HEAD" -- <paths>` into a temporary
   directory outside the repository; do not create a worktree unless the user
   explicitly allows it.

6. Prefer the fetched object diff over `gh pr diff` because it supports target
   tree inspection. If Git fetch is unavailable, use `gh pr diff` as a patch
   fallback, inspect base-side surroundings locally, and state that PR-head
   surrounding-code inspection was limited. Never imply that checked-out base
   files are the PR versions.

## Explicit remote branch/ref

Fetch the requested remote ref without checkout, capture its commit, and diff
from its merge base:

```bash
git fetch --no-tags origin "<remote-branch>"
REMOTE_HEAD=$(git rev-parse FETCH_HEAD)
git fetch --no-tags origin "<base-branch>"
BASE_TIP=$(git rev-parse FETCH_HEAD)
MERGE_BASE=$(git merge-base "$BASE_TIP" "$REMOTE_HEAD")

git diff "$MERGE_BASE...$REMOTE_HEAD"
git log --oneline "$MERGE_BASE..$REMOTE_HEAD"
git diff --stat "$MERGE_BASE...$REMOTE_HEAD"
```

Inspect files with `git show "$REMOTE_HEAD:path"` and search with
`git grep ... "$REMOTE_HEAD"`; do not use the checked-out filesystem as a
substitute for remote-head content.

## Safety and reporting

- Do not switch branches, create a local branch, reset files, stash changes, or
  alter the index.
- Fetching objects and updating `FETCH_HEAD` is allowed; leave user refs and the
  working tree untouched.
- Record the exact target and base OIDs in the page metadata so the explanation
  remains reproducible if the PR advances later.
- In the handoff, explicitly say that the PR/remote ref was inspected without
  checkout and whether any patch-only fallback limited surrounding-code reads.

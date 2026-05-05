export const STATE_VERSION = 1

export const SEED = {
  version: STATE_VERSION,
  config: {},
  prompt_templates: {
    copy_local:
      "You are working through review comments left on a feature branch. Each thread is stored as its own JSON file at `{REPO_PATH}/.reviews/<branch_id>/<thread_id>.json` — every thread block below carries its `File:` path so you can read and edit it from any working directory.\n\nFor each thread:\n\n1. Read the file at the `File:` path. `comments[]` is the conversation: index 0 is the user's original note anchored at the `Source:` line; later entries are prior replies.\n2. Open the source file referenced by `Source:` (path:line) and decide whether a change is warranted. If so, edit the code first.\n3. Append exactly one new entry to `comments[]` (do not edit any other field) with this shape:\n\n       {\n         \"id\":        \"<thread_id>_<N>\",\n         \"user\":      \"claude\",\n         \"posted_at\": \"<current UTC ISO 8601>\",\n         \"body\":      \"<your reply, plain text or markdown>\"\n       }\n\n   - `<thread_id>` is the file's basename without `.json` (also stored in the file's `id` field).\n   - `N` = `comments.length + 1` measured *before* you append.\n\n4. Write the file back, preserving its 2-space JSON indentation.\n\nAfter replying to every thread, summarize the changes you made (no file write needed for the summary).",
  },
  repos: [],
}

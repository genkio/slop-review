// v1 → v2: dropped the persisted `repos[]` bookmark list. The active repo
// is now derived purely from SLOP_REVIEW_REPO at runtime, so state.json
// carries only the schema version plus whatever the frontend has written
// under `config.repo_ui_state.<repoId>`. Agent-facing instructions that
// used to live in `prompt_templates.copy_local` (the now-removed Aggregate
// Prompt clipboard handoff) migrated to the standalone slop-review Claude
// Code skill (`skills/slop-review/SKILL.md`); writeBaseState now strips
// that orphan on persist, so existing user files self-heal on first write.
export const STATE_VERSION = 2

export const SEED = {
  version: STATE_VERSION,
  config: {},
}

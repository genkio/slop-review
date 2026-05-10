// v1 → v2: dropped the persisted `repos[]` bookmark list. The active repo
// is now derived purely from SLOP_REVIEW_REPO at runtime, so state.json
// carries only the schema version. Agent-facing instructions previously
// lived in `prompt_templates.copy_local` (seeded the now-removed Aggregate
// Prompt clipboard handoff) — they migrated to the standalone slop-review
// Claude Code skill (`skills/slop-review/SKILL.md`) installed via
// `slop-review --install-skill`. STATE_VERSION stays at 2; existing user
// state.json files may still carry an orphaned `prompt_templates` key
// (harmless — `loadState` will preserve it, and removing it requires a
// version bump that would needlessly perturb other state).
export const STATE_VERSION = 2

export const SEED = {
  version: STATE_VERSION,
  config: {},
}

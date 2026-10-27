// Canonical key for an exercise, matching the bot's storage convention in
// index.js (`canonicalExerciseForStorage` → `normalizeExerciseSearchText`):
// lowercase, replace every non-alphanumeric run with a single space, collapse
// whitespace, trim. A leading "core-" category prefix (used by the Mini App
// bundle's kebab-case ids) is stripped before normalization so that e.g.
// "core-ab-wheel-rollouts" and "Ab Wheel Rollouts" both canonicalize to
// "ab wheel rollouts" — the same bucket the bot has been writing for months.
//
// Convention and rationale documented in
// docs/exercise_canonical_convention.md — read that before changing this.
export function canonicalizeExerciseKey(input: string | null | undefined): string | null {
  if (input == null) return null;
  const raw = String(input).toLowerCase().trim();
  if (!raw) return null;
  const stripped = raw.replace(/^core-/, "");
  const normalized = stripped
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

// day_type normalization shared between mini-app session writes and bootstrap
// reads. The Telegram bot stores three canonical values: 'upper body',
// 'lower body', 'full body'. The mini-app historically truncated these to
// 'upper'/'lower'/'full', which made bot queries (`WHERE day_type='full body'`)
// silently miss mini-app sessions.
//
// Mirrors index.js:normalizeDayTypeValue(). Returns the original string when
// it doesn't match any known split/short variant — leaves 'push'/'pull'/'legs'
// passing through for plans that opt into those buckets, since the bot has no
// canonical for them either.
export function normalizeDayTypeToCanonical(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input).toLowerCase().trim();
  if (!s) return null;
  if (s === "upper" || s === "upper body") return "upper body";
  if (s === "lower" || s === "lower body") return "lower body";
  if (s === "full" || s === "full body" || s === "total body") return "full body";
  return s;
}

/** Truncate a string to max length, appending '...' if truncated. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/** Format milliseconds as a human-readable duration (e.g., "2h 15m"). */
export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

/** Map RRF score to human-readable relevance label. */
export function formatRelevance(rrfScore: number): string {
  if (rrfScore >= 0.03) return 'high';
  if (rrfScore >= 0.02) return 'medium';
  return 'low';
}

/**
 * Display formatting for the agents pages. Colocated rather than in lib/ —
 * nothing else in the app needs a relative-age string or a run's dollar cost
 * formatted this way yet, so this stays local until a second caller shows up.
 */

/** "3m ago" / "2h ago" / "5d ago" — coarse relative age, newest unit only. */
export function formatAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** A run's cost, stored in micros (1 USD = 1_000_000 micros), as "$0.0031". */
export function formatUsd(micros: number): string {
  return `$${(micros / 1e6).toFixed(4)}`;
}

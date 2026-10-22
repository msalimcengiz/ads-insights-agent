/** Derived ad metrics computed in SQL so every tool reports them the same way. */
export const METRIC_SQL = `
  sum(m.impressions)::bigint AS impressions,
  sum(m.clicks)::bigint AS clicks,
  round(sum(m.spend), 2) AS spend,
  sum(m.conversions)::bigint AS conversions,
  round(sum(m.revenue), 2) AS revenue,
  round(100.0 * sum(m.clicks) / nullif(sum(m.impressions), 0), 3) AS ctr_pct,
  round(sum(m.spend) / nullif(sum(m.clicks), 0), 2) AS cpc,
  round(100.0 * sum(m.conversions) / nullif(sum(m.clicks), 0), 3) AS cvr_pct,
  round(sum(m.spend) / nullif(sum(m.conversions), 0), 2) AS cpa,
  round(sum(m.revenue) / nullif(sum(m.spend), 0), 3) AS roas`;

export const MAX_RANGE_DAYS = 92;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Returns an error message for an invalid range, or null. */
export function checkRange(from: string, to: string, asOf: string): string | null {
  if (!ISO.test(from) || !ISO.test(to)) return 'dates must be YYYY-MM-DD';
  if (from > to) return `date_from (${from}) is after date_to (${to})`;
  if (to > asOf) return `date_to (${to}) is in the future; today is ${asOf}`;
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return `range is longer than ${MAX_RANGE_DAYS} days`;
  return null;
}

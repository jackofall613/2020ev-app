/**
 * Feature 3 — honest-but-rough charging finish estimate.
 *
 * We don't know the car's actual state of charge, so assume half of the
 * driver's target energy remains (ASSUMED_FRACTION_LEFT) and divide by the
 * live draw. The UI labels it "~" and callers fall back to the user-entered
 * estimated_end when there's no car profile or no live load — never show a
 * fake number.
 */

export const ASSUMED_FRACTION_LEFT = 0.5;
const MIN_LOAD_KW_FLOOR = 1;  // taper guard: a trickle draw would produce absurd ETAs
const MAX_ETA_HOURS = 12;

export function computeEtaHours(
  batteryKwh: number,
  targetPercent: number,
  loadKw: number
): number | null {
  if (!(batteryKwh > 0) || !(targetPercent > 0) || !(loadKw > 0)) return null;
  const remainingKwh = batteryKwh * (targetPercent / 100) * ASSUMED_FRACTION_LEFT;
  const hours = remainingKwh / Math.max(loadKw, MIN_LOAD_KW_FLOOR);
  return Math.min(hours, MAX_ETA_HOURS);
}

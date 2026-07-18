/** Pure-function tests for the Feature 3 finish-time estimate. */
import { computeEtaHours, ASSUMED_FRACTION_LEFT } from '../utils/eta';

describe('computeEtaHours (car-profile finish estimate)', () => {
  test('typical L2 charge: 77 kWh @ 80% target on a 6.6 kW draw', () => {
    const hours = computeEtaHours(77, 80, 6.6);
    // 77 * 0.8 * ASSUMED_FRACTION_LEFT / 6.6
    expect(hours).toBeCloseTo((77 * 0.8 * ASSUMED_FRACTION_LEFT) / 6.6, 5);
  });

  test('returns null without a live draw or a usable profile', () => {
    expect(computeEtaHours(77, 80, 0)).toBeNull();
    expect(computeEtaHours(0, 80, 6.6)).toBeNull();
    expect(computeEtaHours(77, 0, 6.6)).toBeNull();
  });

  test('trickle draw is floored so the ETA never explodes', () => {
    // 0.2 kW would naively give 154h; the 1 kW floor + 12h cap keep it honest.
    const hours = computeEtaHours(77, 80, 0.2)!;
    expect(hours).toBeLessThanOrEqual(12);
  });
});

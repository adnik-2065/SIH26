import { expect, it } from 'vitest';
import { summarize } from '../../src/metrics/timings';
it('reports sample count, median, and nearest-rank p95 without mutating samples', () => {
  const samples = [40, 10, 30, 20];
  expect(summarize(samples)).toEqual({ count: 4, median: 25, p95: 40 });
  expect(samples).toEqual([40, 10, 30, 20]);
  expect(summarize([])).toEqual({ count: 0, median: 0, p95: 0 });
});

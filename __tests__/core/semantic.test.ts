import { centroids, NEAR_DUPLICATE, rankChunks, similarItemIds } from '../../src/core/semantic';

const rows = [
  { chunkId: 1, itemId: 'pg1', vector: [1, 0, 0] },
  { chunkId: 2, itemId: 'pg1', vector: [0.9, 0.1, 0] },
  { chunkId: 3, itemId: 'pg2', vector: [0.95, 0.05, 0] }, // same topic, re-shared
  { chunkId: 4, itemId: 'idx', vector: [0.6, 0.8, 0] }, // related
  { chunkId: 5, itemId: 'zoo', vector: [0, 0, 1] }, // unrelated
];

test('item centroids are normalised means of their chunk vectors', () => {
  const c = centroids(rows);
  const v = c.get('pg1')!;
  expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  expect(v[0]).toBeGreaterThan(v[1]);
  expect(c.size).toBe(4);
});

test('similar items are ranked, near-duplicates score above the threshold, unrelated ones are dropped', () => {
  const sim = similarItemIds('pg1', centroids(rows), 5);
  expect(sim.map((s) => s.itemId)).toEqual(['pg2', 'idx']);
  expect(sim[0].score).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
  expect(sim[1].score).toBeLessThan(NEAR_DUPLICATE);
  expect(similarItemIds('missing', centroids(rows))).toEqual([]);
});

test('chunk ranking keeps at most N chunks per item and drops weak matches', () => {
  const r = rankChunks([1, 0, 0], rows, 10, 1);
  expect(r.map((x) => x.itemId)).toEqual(['pg1', 'pg2', 'idx']);
  expect(r.some((x) => x.itemId === 'zoo')).toBe(false);
});

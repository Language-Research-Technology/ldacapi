import { describe, expect, it } from 'vitest';
import { sizedChunks } from './chunks.ts';

describe('sizedChunks', () => {
  const sizeOf = (item: string) => item.length;

  it('starts a new run before one would pass the size limit', () => {
    expect(sizedChunks(['aa', 'bb', 'cc', 'd'], { count: 10, bytes: 4, sizeOf })).toEqual([
      ['aa', 'bb'],
      ['cc', 'd'],
    ]);
  });

  it('starts a new run once one holds `count` items', () => {
    expect(sizedChunks(['a', 'b', 'c'], { count: 2, bytes: 100, sizeOf })).toEqual([['a', 'b'], ['c']]);
  });

  it('gives an item larger than the limit a run of its own', () => {
    expect(sizedChunks(['a', 'huge', 'b'], { count: 10, bytes: 2, sizeOf })).toEqual([['a'], ['huge'], ['b']]);
  });

  it('gives no runs for no items', () => {
    expect(sizedChunks([], { count: 10, bytes: 2, sizeOf })).toEqual([]);
  });
});

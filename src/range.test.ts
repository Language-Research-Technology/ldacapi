import { describe, expect, it } from 'vitest';
import { parseRange } from './range.ts';

describe('parseRange', () => {
  it('ignores a missing, malformed or multi-range header', () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange('items=0-10', 100)).toBeUndefined();
    expect(parseRange('bytes=-', 100)).toBeUndefined();
    expect(parseRange('bytes=10-5', 100)).toBeUndefined();
    expect(parseRange('bytes=0-10,20-30', 100)).toBeUndefined();
  });

  it('resolves a closed range, clamping the end to the file', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
  });

  it('resolves an open-ended range', () => {
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
  });

  it('resolves a suffix range', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('rejects a range starting past the end of the file', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-10', 0)).toBe('unsatisfiable');
  });
});

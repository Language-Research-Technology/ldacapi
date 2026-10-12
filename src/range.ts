export type ByteRange = { start: number; end: number };

/**
 * Resolve a single-range `Range` header (RFC 9110 §14.1.2) against a file size.
 * Returns undefined when the header should be ignored (absent, malformed or
 * multi-range), so the whole file is served.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return;
  }
  const [, first, last] = match;
  if (!first && !last) {
    return;
  }

  if (!first) {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(first);
  if (last && Number(last) < start) {
    return;
  }
  if (start >= size) {
    return 'unsatisfiable';
  }
  return { start, end: last ? Math.min(Number(last), size - 1) : size - 1 };
}

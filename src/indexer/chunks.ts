/** `items` in runs of at most `size` */
export const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** `items` in runs of at most `count` items and, unless one item alone is larger, at most `bytes` by `sizeOf` */
export function sizedChunks<T>(items: T[], { count, bytes, sizeOf }: { count: number; bytes: number; sizeOf: (item: T) => number }) {
  const runs: T[][] = [];
  let run: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = sizeOf(item);
    if (run.length > 0 && (run.length === count || size + itemSize > bytes)) {
      runs.push(run);
      run = [];
      size = 0;
    }
    run.push(item);
    size += itemSize;
  }
  if (run.length > 0) {
    runs.push(run);
  }
  return runs;
}

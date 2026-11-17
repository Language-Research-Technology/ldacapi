import { SHAPES, type Shape } from './generate.ts';

export type BenchmarkCommand = { command: 'run'; shapes: Shape[] } | { command: 'generate'; dir: string; shapes: Shape[] };

const isShape = (shape: string): shape is Shape => (SHAPES as readonly string[]).includes(shape);

/** The command `positionals` ask for, over `shapes` (by default every shape), or what is wrong with them */
export function benchmarkCommand(positionals: string[], shapes: string[] = [...SHAPES]): BenchmarkCommand | { problem: string } {
  const unknown = shapes.find((shape) => !isShape(shape));
  if (unknown !== undefined) {
    return { problem: `Unknown shape: ${unknown}` };
  }
  const known = shapes.filter(isShape);
  const [command = 'run', dir] = positionals;
  if (command === 'run') {
    return { command, shapes: known };
  }
  if (command !== 'generate') {
    return { problem: `Unknown command: ${command}` };
  }
  return dir ? { command, dir, shapes: known } : { problem: 'generate needs a directory' };
}

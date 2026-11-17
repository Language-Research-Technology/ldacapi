import { describe, expect, it } from 'vitest';
import { benchmarkCommand } from './command.ts';

describe('the benchmark command', () => {
  it('runs every shape by default', () => {
    expect(benchmarkCommand([])).toEqual({ command: 'run', shapes: ['one-crate', 'split'] });
  });

  it('runs the shapes asked for', () => {
    expect(benchmarkCommand(['run'], ['split'])).toEqual({ command: 'run', shapes: ['split'] });
  });

  it('generates into a directory', () => {
    expect(benchmarkCommand(['generate', 'out'], ['one-crate'])).toEqual({ command: 'generate', dir: 'out', shapes: ['one-crate'] });
  });

  it.each([
    [['generate'], undefined, 'generate needs a directory'],
    [['bench'], undefined, 'Unknown command: bench'],
    [['run'], ['split', 'round'], 'Unknown shape: round'],
  ])('refuses %o with shapes %o: %s', (positionals, shapes, problem) => {
    expect(benchmarkCommand(positionals, shapes)).toEqual({ problem });
  });
});

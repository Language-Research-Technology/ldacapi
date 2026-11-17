import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FULL_SIZE, generateCollection, SHAPES, type Shape } from '../src/benchmark/generate.ts';

const HELP = `Benchmarks indexing over a generated collection, by default 30,031 entities.

Usage:
  pnpm benchmark [options]                  Generate, import and index each shape; print time, peak memory
                                            and how much slower aggregates make a page of 100 entities
  pnpm benchmark generate <dir> [options]   Only write the crates of each shape, to <dir>/<shape>

Each run indexes into a new database and search index (named after DATABASE_URL and ENTITY_INDEX, with a
"_benchmark_" suffix), which it drops afterwards. Postgres and OpenSearch must be running (docker compose up).
The indexing process's log is kept at <work-dir>/<shape>/index.log; set LOG_LEVEL=warn to quieten the
import's own log. Not run by pnpm test or CI.

Options:
  --shape <shape>      one-crate or split; repeat for both (default: both)
  --collections <n>    sub-collections under the top collection (default: ${FULL_SIZE.collections})
  --objects <n>        objects per sub-collection (default: ${FULL_SIZE.objectsPerCollection})
  --files <n>          files per object, one of them a text transcript (default: ${FULL_SIZE.filesPerObject})
  --seed <n>           the same seed and sizes give byte-identical crates (default: 1)
  --work-dir <dir>     where crates and repositories are written (default: storage/benchmark)
  --keep               keep the generated crates and repositories
  -h, --help           show this help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    shape: { type: 'string', multiple: true },
    collections: { type: 'string', default: String(FULL_SIZE.collections) },
    objects: { type: 'string', default: String(FULL_SIZE.objectsPerCollection) },
    files: { type: 'string', default: String(FULL_SIZE.filesPerObject) },
    seed: { type: 'string', default: '1' },
    'work-dir': { type: 'string', default: 'storage/benchmark' },
    keep: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command = 'run', dir] = positionals;
const shapes = (values.shape ?? SHAPES) as Shape[];
const unknownShape = shapes.find((shape) => !SHAPES.includes(shape));

if (values.help || !['run', 'generate'].includes(command) || (command === 'generate' && !dir) || unknownShape) {
  if (unknownShape) {
    console.error(`Unknown shape: ${unknownShape}\n`);
  }
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const size = {
  collections: Number(values.collections),
  objectsPerCollection: Number(values.objects),
  filesPerObject: Number(values.files),
  seed: Number(values.seed),
};

if (command === 'generate') {
  for (const shape of shapes) {
    const out = resolve(dir as string, shape);
    const { crates, entities } = await generateCollection(out, { ...size, shape });
    console.log(`${shape}: ${crates} crates, ${entities} entities in ${out}`);
  }
} else {
  // Loaded only to run, as it reads the configuration
  const { discardRepository, prepareRepository, report, runBenchmark } = await import('../src/benchmark/run.ts');
  for (const shape of shapes) {
    console.log(`${shape}: generating and importing`);
    const repository = await prepareRepository(resolve(values['work-dir'], shape), { ...size, shape });
    console.log(`${shape}: indexing`);
    const result = await runBenchmark(repository);
    console.log(report(shape, repository, result));
    if (!values.keep) {
      await discardRepository(repository);
    }
  }
}

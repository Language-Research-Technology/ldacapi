import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../configuration.ts';
import { importCrates } from '../crates-import.ts';
import { PrismaClient } from '../generated/prisma/client.ts';
import { aggregatesOf } from '../oni.ts';
import { openOrCreateRepository } from '../repository/repository.ts';
import { type GenerateOptions, generateCollection } from './generate.ts';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The node arguments of the process the benchmark measures, which indexes the whole repository and exits */
const INDEX_EVERYTHING = ['scripts/index.ts'];

/** Loaded into the indexing process to report its resource usage on fd 3 as it exits */
const USAGE_REPORTER = `data:text/javascript,${encodeURIComponent(
  "import { writeSync } from 'node:fs'; process.on('exit', () => writeSync(3, JSON.stringify(process.resourceUsage())));",
)}`;

export type BenchmarkRepository = { root: string; workDir: string; crates: number; entities: number };

const sourceOf = (workDir: string) => join(workDir, 'crates');

/** Removes the generated crates and the repository, keeping the indexing log */
export async function discardRepository({ workDir, root }: Pick<BenchmarkRepository, 'workDir' | 'root'>) {
  await rm(sourceOf(workDir), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

/** Generates the collection under `workDir` and imports it into a new OCFL repository there, replacing any earlier one */
export async function prepareRepository(workDir: string, options: GenerateOptions): Promise<BenchmarkRepository> {
  const source = sourceOf(workDir);
  const root = join(workDir, 'ocfl');
  await discardRepository({ workDir, root });
  const { crates, entities } = await generateCollection(source, options);
  if (!(await importCrates(await openOrCreateRepository(root), source))) {
    throw new Error(`Could not import every crate from ${source}`);
  }
  return { root, workDir, crates, entities };
}

const prismaFor = (url: URL) => new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });

/** A new database, migrated, and a search index name, each named apart from any other run's */
async function freshIndexes() {
  const suffix = `benchmark_${randomBytes(3).toString('hex')}`;
  const databaseUrl = new URL(config.databaseUrl);
  const database = `${databaseUrl.pathname.slice(1)}_${suffix}`;
  databaseUrl.pathname = `/${database}`;
  const entityIndex = `${config.search.entityIndex}_${suffix}`;

  const maintenanceUrl = new URL(config.databaseUrl);
  maintenanceUrl.pathname = '/postgres';
  const admin = prismaFor(maintenanceUrl);
  const opensearch = new Client({ node: config.opensearchUrl });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);

  const drop = async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await opensearch.indices.delete({ index: entityIndex, ignore_unavailable: true });
    await opensearch.indices.deleteIndexTemplate({ name: entityIndex }).catch(() => {});
    await Promise.all([admin.$disconnect(), opensearch.close()]);
  };

  try {
    await promisify(execFile)('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    });
  } catch (error) {
    await drop();
    throw error;
  }

  /** How many rows and search documents the indexes hold */
  const count = async () => {
    const prisma = prismaFor(databaseUrl);
    try {
      await opensearch.indices.refresh({ index: entityIndex, ignore_unavailable: true });
      const { body } = await opensearch.count({ index: entityIndex });
      return { rows: await prisma.entity.count(), documents: body.count };
    } finally {
      await prisma.$disconnect();
    }
  };

  const aggregatesRead = async () => {
    const prisma = prismaFor(databaseUrl);
    try {
      return await timeAggregatesRead(prisma);
    } finally {
      await prisma.$disconnect();
    }
  };

  return { databaseUrl, entityIndex, count, aggregatesRead, drop };
}

/** Reads of the page measured, after one to warm up */
const READS = 21;

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] as number;

/**
 * How long a page of 100 entity rows takes to read with and without their aggregates, as Oni's entity transformer reads
 * them, in milliseconds (the median of `READS`). The page starts at the top collection, which has the most aggregate rows
 */
async function timeAggregatesRead(prisma: PrismaClient) {
  const ids = (await prisma.entity.findMany({ select: { id: true }, orderBy: { id: 'asc' }, take: 100 })).map(({ id }) => id);
  const page = () => prisma.entity.findMany({ where: { id: { in: ids } } });
  const timed = async (read: () => Promise<unknown>) => {
    await read();
    const times: number[] = [];
    for (let i = 0; i < READS; i++) {
      const started = performance.now();
      await read();
      times.push(performance.now() - started);
    }
    return median(times);
  };
  const without = await timed(page);
  const withAggregates = await timed(async () => {
    await page();
    await aggregatesOf(prisma, ids);
  });
  return { without, with: withAggregates };
}

/** Runs `args` under node, returning its wall-clock time and peak resident memory */
async function measure(args: string[], env: NodeJS.ProcessEnv, logFile: string) {
  const log = await open(logFile, 'w');
  try {
    const started = performance.now();
    const child = spawn(process.execPath, ['--import', USAGE_REPORTER, ...args], { cwd: PROJECT_ROOT, env, stdio: ['ignore', log.fd, log.fd, 'pipe'] });
    let usage = '';
    child.stdio[3]?.on('data', (chunk: Buffer) => {
      usage += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    const seconds = (performance.now() - started) / 1000;
    if (code !== 0) {
      throw new Error(`Indexing exited with ${code}; see ${logFile}`);
    }
    const { maxRSS } = JSON.parse(usage) as NodeJS.ResourceUsage;
    return { seconds, peakMemoryBytes: maxRSS * 1024 };
  } finally {
    await log.close();
  }
}

/**
 * Indexes the repository into a new database and search index, which it drops afterwards, timing the indexing
 * process and taking its peak memory. Its log goes to `index.log` in the work directory.
 */
export async function runBenchmark(repository: BenchmarkRepository, args = INDEX_EVERYTHING) {
  const indexes = await freshIndexes();
  const logFile = join(repository.workDir, 'index.log');
  try {
    const env = {
      ...process.env,
      DATABASE_URL: indexes.databaseUrl.toString(),
      ENTITY_INDEX: indexes.entityIndex,
      OCFL_ROOT: repository.root,
      LOG_LEVEL: 'info',
    };
    const measured = await measure(args, env, logFile);
    return { ...measured, ...(await indexes.count()), aggregatesRead: await indexes.aggregatesRead(), logFile };
  } finally {
    await indexes.drop();
  }
}

export type BenchmarkResult = Awaited<ReturnType<typeof runBenchmark>>;

/**
 * The targets: the largest collection indexed in under 10 minutes, with the indexing process under 1 GB; a page of
 * entities at most 50 ms slower to read with aggregates
 */
const TARGET = { seconds: 600, peakMemoryBytes: 1024 ** 3, aggregatesReadMilliseconds: 50 };

/** One line on a shape's run, and whether it met the target */
export function report(shape: string, repository: BenchmarkRepository, result: BenchmarkResult) {
  const n = (value: number) => value.toLocaleString('en-AU');
  const met = result.seconds < TARGET.seconds && result.peakMemoryBytes < TARGET.peakMemoryBytes;
  const read = result.aggregatesRead;
  const slower = read.with - read.without;
  const ms = (value: number) => `${value.toFixed(1)} ms`;
  return [
    `${shape}: ${n(repository.crates)} ${repository.crates === 1 ? 'crate' : 'crates'}, ${n(repository.entities)} entities`,
    `indexed ${n(result.rows)} rows and ${n(result.documents)} search documents`,
    `in ${result.seconds.toFixed(1)} s, peak memory ${n(Math.round(result.peakMemoryBytes / 1024 ** 2))} MB`,
    `(target under 10 minutes and 1 GB: ${met ? 'met' : 'missed'})`,
    `a page of 100 entities read in ${ms(read.without)} without aggregates and ${ms(read.with)} with, ${ms(slower)} slower`,
    `(target at most 50 ms slower: ${slower <= TARGET.aggregatesReadMilliseconds ? 'met' : 'missed'})`,
  ].join('; ');
}

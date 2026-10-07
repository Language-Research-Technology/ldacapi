import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROCrate } from 'ro-crate';
import { config } from '../src/configuration.ts';
import { createStorage } from '../src/ocfl.ts';

const source = resolve(process.argv[2] ?? 'test-data');

const repository = createStorage();
if (await repository.exists()) {
  await repository.load();
} else {
  await repository.create();
}

const directories = await readdir(source, { withFileTypes: true });
for (const directory of directories.filter((entry) => entry.isDirectory())) {
  const path = join(source, directory.name);
  const crate = await ROCrate.create(JSON.parse(await readFile(join(path, 'ro-crate-metadata.json'), 'utf-8')));
  await repository.object(crate.rootId).import(path);
  console.log(`Imported ${crate.rootId} from ${path}`);
}
console.log(`Seeded the OCFL repository at ${config.ocfl.root}`);

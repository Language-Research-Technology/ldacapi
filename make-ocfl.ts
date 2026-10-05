import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ocfl from '@ocfl/ocfl-fs';

const repository = ocfl.storage({
  root: '/opt/storage/oni/ocfl',
  layout: {
    extensionName: '000N-path-direct-storage-layout',
  },
  fixityAlgorithms: ['crc32'],
});
try {
  await repository.load();
} catch {
  await repository.create();
}

const directories = await readdir('./test-data');
for (const name of directories) {
  const base = join('./test-data', name);
  try {
    const meta = JSON.parse(await readFile(join(base, 'ro-crate-metadata.json'), { encoding: 'utf-8' }));
    const objectName = meta['@graph'][0].about['@id'];
    const o = repository.object(objectName);
    await o.import(base);
  } catch {
    // FIXME: Why are we ignoring all errors?
  }
}

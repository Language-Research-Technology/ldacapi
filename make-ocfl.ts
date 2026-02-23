import { createStorage } from '@ocfl/ocfl-fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repository = await createStorage({
  root: './ocfl',
  layout: {
    extensionName: '000N-path-direct-storage-layout'
  },
  fixityAlgorithms: ['size', 'crc32']
});

const directories = await readdir('./test-data');
for (let name of directories) {
  const base = join('./test-data', name);
  try {
    const meta = JSON.parse(await readFile(join(base, 'ro-crate-metadata.json'), { encoding: 'utf-8' }));
    const objectName = meta['@graph'][0].about['@id'];
    const o = repository.object(objectName);
    await o.import(base);
  } catch (error) {
  }
}

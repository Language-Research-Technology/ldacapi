import type { PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import type { Document, SearchBackend } from '../search-backend.ts';
import type { ReadText } from './crate.ts';
import type { Derivation } from './derive.ts';
import { crateRowIds } from './rows.ts';

const log = logger.child({ module: 'indexer/documents' });

/** Caps on one bulk request */
const MAX_DOCUMENTS = 1000;
const MAX_BYTES = 5 * 1024 * 1024;

/** Writes a crate's search documents */
export class DocumentsWriter {
  prisma: PrismaClient;
  search: SearchBackend;

  constructor(prisma: PrismaClient, search: SearchBackend) {
    this.prisma = prisma;
    this.search = search;
  }

  /** Run before the rows are deleted, as it finds the documents by them */
  async delete(crateId: string) {
    const ids = await crateRowIds(this.prisma, crateId);
    for (let i = 0; i < ids.length; i += MAX_DOCUMENTS) {
      await this.search.remove(ids.slice(i, i + MAX_DOCUMENTS));
    }
  }

  /** Only for entities in `written`, as arocapi drops a hit without a row but still counts it */
  async write(derivation: Derivation, readText: ReadText, written: Set<string>) {
    let batch: Document[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length > 0) {
        await this.search.index(batch);
      }
      batch = [];
      bytes = 0;
    };
    for (const { document, textPath } of derivation.entities) {
      if (!written.has(document.id)) {
        log.warn({ crateId: derivation.crateId, entityId: document.id }, 'Skipped: no database row');
        continue;
      }
      const text = textPath && (await readText(textPath));
      const doc = text ? { ...document, text } : document;
      const size = Buffer.byteLength(JSON.stringify(doc));
      if (batch.length === MAX_DOCUMENTS || bytes + size > MAX_BYTES) {
        await flush();
      }
      batch.push(doc);
      bytes += size;
    }
    await flush();
  }
}

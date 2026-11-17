import type { PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import type { Document, SearchBackend } from '../search-backend.ts';
import { chunks } from './chunks.ts';
import type { ReadText } from './crate.ts';
import type { Derivation } from './derive.ts';
import { type Copy, linksById, lockEntities, TRANSACTION, winner } from './links.ts';
import type { Progress } from './progress.ts';

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

  /** Removes the documents of the entities no other crate contains, returning their ids. Run before the crate's links go, as it finds them by them */
  async delete(crateId: string) {
    const ids = (
      await this.prisma.$queryRaw<{ entityId: string }[]>`
        SELECT "entityId" FROM crate_link link WHERE "crateId" = ${crateId}
        AND NOT EXISTS (SELECT 1 FROM crate_link other WHERE other."entityId" = link."entityId" AND other."crateId" <> ${crateId})`
    ).map(({ entityId }) => entityId);
    for (const batch of chunks(ids, MAX_DOCUMENTS)) {
      await this.search.remove(batch);
    }
    return ids;
  }

  /** Makes the documents of `ids` what their links say: none with no link left, or a shared entity's winning copy */
  async sync(ids: string[], progress?: Progress) {
    for (const batch of chunks(ids, MAX_DOCUMENTS)) {
      await this.prisma.$transaction(async (tx) => {
        await lockEntities(tx, batch);
        const links = linksById(
          batch,
          await tx.crateLink.findMany({ where: { entityId: { in: batch } }, select: { entityId: true, crateId: true, openMetadata: true, copy: true } }),
        );
        const unlinked: string[] = [];
        const copies: Document[] = [];
        for (const [id, all] of links) {
          const best = winner(all);
          if (!best) {
            unlinked.push(id);
            continue;
          }
          // A held entity has no copy only when another crate claims it while this one's crate is deleted
          /* v8 ignore next 3 */
          if (best.copy) {
            copies.push((best.copy as Copy).document);
          }
        }
        if (unlinked.length > 0) {
          await this.search.remove(unlinked);
        }
        if (copies.length > 0) {
          await this.search.index(copies);
        }
      }, TRANSACTION);
      progress?.advance(batch.length);
    }
  }

  /** The crate's own documents for what it holds, and the winning copy for the shared entities it contains */
  async write(derivation: Derivation, readText: ReadText, progress: Progress) {
    progress.start('search index', derivation.entities.length);
    let batch: Document[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length > 0) {
        await this.search.index(batch);
      }
      progress.advance(batch.length);
      batch = [];
      bytes = 0;
    };
    for (const { document, textPath, shared } of derivation.entities) {
      if (shared) {
        continue;
      }
      const text = textPath && (await progress.onItem(document.id, () => readText(textPath)));
      const doc = text ? { ...document, text } : document;
      const size = Buffer.byteLength(JSON.stringify(doc));
      if (batch.length === MAX_DOCUMENTS || bytes + size > MAX_BYTES) {
        await flush();
      }
      batch.push(doc);
      bytes += size;
      log.debug({ crateId: derivation.crateId, entityId: document.id }, 'Entity indexed');
    }
    await flush();
    await this.sync(
      derivation.entities.filter(({ shared }) => shared).map(({ row }) => row.id),
      progress,
    );
  }
}

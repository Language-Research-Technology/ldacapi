-- Rows indexed before crate links have no record of their crates
DELETE FROM "file";
DELETE FROM "entity";
DELETE FROM "aggregate";
UPDATE "crate" SET "indexedVersion" = NULL, "indexedAt" = NULL, "entities" = NULL, "files" = NULL;

-- CreateTable
CREATE TABLE "crate_link" (
    "crateId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "copy" JSONB,
    "openMetadata" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "crate_link_pkey" PRIMARY KEY ("crateId","entityId")
);

-- CreateIndex
CREATE INDEX "crate_link_entityId_idx" ON "crate_link"("entityId");

-- AddForeignKey
ALTER TABLE "crate_link" ADD CONSTRAINT "crate_link_crateId_fkey" FOREIGN KEY ("crateId") REFERENCES "crate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

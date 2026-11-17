-- CreateTable
CREATE TABLE "aggregate" (
    "entityId" TEXT NOT NULL,
    "crateId" TEXT NOT NULL,
    "collections" INTEGER NOT NULL,
    "objects" INTEGER NOT NULL,
    "subCollections" INTEGER NOT NULL,
    "files" INTEGER NOT NULL,
    "language" TEXT[],
    "communicationMode" TEXT[],
    "mediaType" TEXT[],

    CONSTRAINT "aggregate_pkey" PRIMARY KEY ("entityId","crateId")
);

-- CreateIndex
CREATE INDEX "aggregate_crateId_idx" ON "aggregate"("crateId");

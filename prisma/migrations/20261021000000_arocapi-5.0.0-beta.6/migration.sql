-- CreateTable
CREATE TABLE "entity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "memberOf" TEXT,
    "rootCollection" TEXT,
    "metadataLicenseId" TEXT NOT NULL,
    "contentLicenseId" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_search" (
    "id" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "basic" tsvector NOT NULL,
    "text" tsvector NOT NULL,
    "point" point,
    "geohash" TEXT,

    CONSTRAINT "entity_search_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entity_memberOf_idx" ON "entity"("memberOf");

-- CreateIndex
CREATE INDEX "entity_rootCollection_idx" ON "entity"("rootCollection");

-- CreateIndex
CREATE INDEX "entity_entityType_idx" ON "entity"("entityType");

-- CreateIndex
CREATE INDEX "entity_search_values_idx" ON "entity_search" USING GIN ("values" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "entity_search_basic_idx" ON "entity_search" USING GIN ("basic");

-- CreateIndex
CREATE INDEX "entity_search_text_idx" ON "entity_search" USING GIN ("text");

-- CreateIndex
CREATE INDEX "entity_search_point_idx" ON "entity_search" USING GIST ("point");

-- AddForeignKey
ALTER TABLE "entity_search" ADD CONSTRAINT "entity_search_id_fkey" FOREIGN KEY ("id") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_id_fkey" FOREIGN KEY ("id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "entity" (
    "id" VARCHAR(768) NOT NULL,
    "name" VARCHAR(512) NOT NULL,
    "description" TEXT NOT NULL,
    "entityType" VARCHAR(255) NOT NULL,
    "memberOf" VARCHAR(768),
    "rootCollection" VARCHAR(768),
    "metadataLicenseId" VARCHAR(255) NOT NULL,
    "contentLicenseId" VARCHAR(255) NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file" (
    "id" VARCHAR(768) NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mediaType" VARCHAR(127) NOT NULL,
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

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_id_fkey" FOREIGN KEY ("id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


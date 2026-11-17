-- CreateEnum
CREATE TYPE "index_job_kind" AS ENUM ('index', 'reindex', 'delete');

-- CreateEnum
CREATE TYPE "index_job_status" AS ENUM ('waiting', 'running', 'failed');

-- CreateTable
CREATE TABLE "index_job" (
    "id" SERIAL NOT NULL,
    "crateId" TEXT NOT NULL,
    "kind" "index_job_kind" NOT NULL,
    "status" "index_job_status" NOT NULL DEFAULT 'waiting',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "index_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "indexedVersion" INTEGER,
    "indexedAt" TIMESTAMP(3),
    "entities" INTEGER,
    "files" INTEGER,

    CONSTRAINT "crate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "index_worker" (
    "id" TEXT NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "index_worker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "index_job_crateId_idx" ON "index_job"("crateId");

-- AddForeignKey
ALTER TABLE "index_job" ADD CONSTRAINT "index_job_crateId_fkey" FOREIGN KEY ("crateId") REFERENCES "crate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One waiting and one running job per crate, written by hand as Prisma has no partial indexes
CREATE UNIQUE INDEX "index_job_one_waiting" ON "index_job"("crateId") WHERE "status" = 'waiting';
CREATE UNIQUE INDEX "index_job_one_running" ON "index_job"("crateId") WHERE "status" = 'running';

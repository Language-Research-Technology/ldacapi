-- AlterTable
ALTER TABLE "index_job" ADD COLUMN     "done" INTEGER,
ADD COLUMN     "failedOn" TEXT,
ADD COLUMN     "stage" TEXT,
ADD COLUMN     "total" INTEGER;

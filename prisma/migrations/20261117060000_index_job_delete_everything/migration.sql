-- A job with no crate deletes everything
ALTER TABLE "index_job" ALTER COLUMN "crateId" DROP NOT NULL;

-- One waiting and one running job per crate, and one of each with no crate
DROP INDEX "index_job_one_waiting";
DROP INDEX "index_job_one_running";
CREATE UNIQUE INDEX "index_job_one_waiting" ON "index_job"("crateId") NULLS NOT DISTINCT WHERE "status" = 'waiting';
CREATE UNIQUE INDEX "index_job_one_running" ON "index_job"("crateId") NULLS NOT DISTINCT WHERE "status" = 'running';

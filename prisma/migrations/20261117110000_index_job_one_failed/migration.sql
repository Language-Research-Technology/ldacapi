-- One failed job per crate, and one with no crate, written by hand as Prisma has no partial indexes
CREATE UNIQUE INDEX "index_job_one_failed" ON "index_job"("crateId") NULLS NOT DISTINCT WHERE "status" = 'failed';

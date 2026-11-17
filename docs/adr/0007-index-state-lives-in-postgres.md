# Index state lives in Postgres, and the admin pages read only that

## Context

Indexing runs in a worker that drains a durable queue shared with the API and the CLI (ADR 0005). The queue has to survive restarts, let each index job be claimed by exactly one of any number of workers, and hold a crate to one running and one waiting job. Indexing a crate only when its head version has changed needs a lasting note of the version its indexes were built from. The admin pages need each crate's index state and counts.

Before this, index state was held in the API's memory, whether a crate was indexed was worked out by counting its rows and documents, and every load of the crates page walked the OCFL repository and parsed each crate's metadata for its name.

pg-boss and Redis with BullMQ were the alternatives for the queue. pg-boss keeps its own schema outside our migrations and has its own job states to map ours onto. Redis is one more service to deploy. The queue is small, one job per crate, and the admin pages want to query it directly.

## Decision

Index state is kept in our own Postgres tables, beside the database index.

- The queue is a table of index jobs. A worker claims a job in a transaction that skips rows another worker has locked, and the database enforces one running and one waiting job per crate.
- Each crate known to be in the repository has one record: its name, its indexed version, when that was indexed, and how many entities and files the job wrote. The indexed version is cleared before a job changes either index and set as the job's last step, so a crate is either indexed at a known version or needs a job.
- Deleting a crate's indexes keeps its record, as not indexed. A record is removed only when a job finds its crate is gone from the repository.
- A job that succeeds is removed; its result is the record. A failed job is kept with its error until another job for that crate is asked for.
- Each worker, and each CLI run while it runs the queue, records a heartbeat. A job whose worker has gone silent is returned to the queue.
- The admin pages read these tables and never the repository. A crate's index state is derived from its jobs and its record.

## Consequences

- A crate is listed on the admin pages once something has asked to index it: Deposit, Import or indexing everything. A crate another tool put in the repository is not listed until someone indexes everything, and a repository indexed in place shows no crates until then.
- The pages can't show that a crate's indexes are behind its head version, as that would mean reading the repository.
- Loading the crates page costs the same however large the repository is.
- A job that fails part-way, such as documents removed but rows not, leaves a record with no indexed version and a failed job. Asking again finishes it, as indexing and deleting are both safe to repeat. There is no repair step.
- The admin pages can show that no worker is running, from the heartbeats.
- Index state is not rebuilt from the repository as the indexes are. If it is lost, indexing everything restores it by reindexing every crate.
- Claiming jobs, returning a dead worker's jobs and pruning are our code to maintain.

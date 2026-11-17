# Indexing runs in a worker that drains a durable queue

## Context

Crates reach the repository three ways: Deposit, Import, and an existing OCFL repository indexed in place. All three end in the same work, indexing one crate. That work is slow and CPU-bound: the largest collection has about 30,000 entities, and parsing a crate blocks Node's one thread. The repository is the source of truth, and both indexes can be rebuilt from it at any time. `@ocfl/ocfl-fs` has no way to watch a repository or ask what changed.

Running the same queue from a loop inside the API process was the alternative. It needs one process instead of two, but indexing a large crate would stall requests, could run the API out of memory, and would be interrupted by every API restart, and indexing capacity would follow the number of API replicas.

## Decision

Indexing never runs in the API process. Every request to index or delete a crate's indexes is an index job on one durable queue, and a separate worker process, the same image with its own command, runs the jobs.

- The API only adds jobs: from the admin pages, and from Deposit once the crate is written to the repository.
- The CLI adds jobs and then runs the queue itself until it is empty, so it works with or without a worker running.
- Indexing starts only when something asks for it. Nothing runs on a schedule or watches the repository.
- A job is for one crate, names it by id only, and builds both indexes from the head version in the repository. Wider requests become one job per crate.
- A crate has at most one running job and one waiting job.

## Consequences

- A deployment runs two processes, and the worker needs the repository, the database and the search backend. If no worker is running, jobs wait, so the admin pages have to show that.
- A deposit succeeds once the crate is stored. Its entities appear in the API after its job has run, and an indexing failure is a failed job to ask for again, not a failed deposit.
- Any number of API replicas, workers and CLI runs can share the queue, because each job is claimed once.
- A crate changed or removed in the repository by another tool is stale in the indexes until someone asks to index it or to index everything.
- A job that fails because of its crate waits to be asked for again. A job whose worker died is run again.

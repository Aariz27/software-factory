# Data contract

> Hand-written by you. One block per distinct piece of data the project touches
> (a table, a file, a payload, an event, a credential). A blank or a guess in any
> row is where the work gets wasted later, so verify what you can against the
> real thing (call the endpoint once, print the schema, `ls` the path) and mark
> what you could not verify with `?`.
> `/plan` reads this. `/prototype data_contract` draws it.

## Pieces of data

Copy this block once per piece of data:

### <name of the data>
- **WHERE** — durable home, and where it goes next. Exactly one source of truth?
- **WHEN** — what triggers it to move; how fresh it must be; is the trigger actually wired?
- **HOW** — exact shape (fields, types, encoding), transport, and lifetime of any URL / token / session:
- **WHAT on arrival** — validate / dedup / persist / side-effects; who reads it next:
- **ORDER** — what must happen before / after; is any write committed before the action it records has succeeded?
- **Verified?** — yes / `?` and how you checked:

## Pre-flight checklist (answer yes/no for the whole project)
1. Public-URL sink? Any external service that needs a public URL rather than a local path, and when that URL expires:
2. External shape verified? Input and output shape of every API / tool / CLI / MCP confirmed by docs or one real call:
3. One source of truth for every count, status, and "done" flag:
4. Live vs stale: anything read from a snapshot, cache, log or comment that may be out of date:
5. Write-after-success: every "X happened" write lands only after X succeeded, and is released on failure:
6. Join key declared: every filename / slug / id linking two stores has one derivation rule on both sides:
7. Credentials mapped: type, location, freshness, and permission to do the write:
8. Schema home + trigger for every required field / event:
9. Infrastructure confirmed to exist and be reachable before the design depends on it:

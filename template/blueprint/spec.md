# Spec

> Hand-written by you. The technical decisions for this project, one field at a
> time. Not every field applies: write `N/A — reason` instead of deleting it, so
> the reasoning stays visible to whoever (or whatever) reads this later.
> When this and the other four docs (`data_contract.md`, `features.md`, `ux.md`,
> `ui.md`) are filled in, run `/plan` to generate `build-plan.md`.

## 1. Backend fundamentals
- Server/runtime:
- Framework / routing:
- Core routes or endpoints:
- Request and response shape per route:
- Environment variables (names only) and where they live:
- The core rule the backend must enforce:

## 2. Integration engineering
- Third-party APIs called:
- Webhooks sent or received:
- Services needing OAuth, and scopes:
- SDK vs raw HTTP per service:
- Rate limits per dependency, and what happens on hitting them:
- Anything routed through Zapier / Make / n8n instead of code:

## 3. DevOps / deployment
- Host:
- Docker or native:
- Domains and SSL:
- Env vars that differ between staging and production:
- Manual deploy or CI/CD:
- Staging environment, or straight to production:

## 4. AI agent infrastructure
- MCP servers needed:
- Tools the agent may use:
- Memory: session / persistent / vector:
- Retrieval: what, from where:
- Permissions and guardrails on the agent:
- Evals: what "correct" looks like:
- What triggers a tool call vs a direct answer:

## 5. Databases and data modelling
- Database / platform:
- Tables and columns (detail lives in `data_contract.md`):
- Relationships (foreign keys):
- Indexes, and why:
- Constraints (unique, not null):
- ORM or raw SQL:
- Migration plan:
- Platform-specific features used (storage, auth, edge functions, realtime):

## 6. Authentication and permissions
- Login method (OAuth / email+password / magic link):
- Session or token shape (JWT / cookie / API key):
- Roles and what each may do:
- Row-level policies: who sees / edits what:
- Machine-to-machine keys and their scope:

## 7. Background jobs and events
- Work that must run async:
- Trigger per job (queue / cron / event):
- On failure: retries, dead-letter, alert:
- Queue / worker setup:

## 8. Observability and reliability
- What is logged, and where logs go:
- How you find out something broke:
- Retry / timeout policy per external call:
- Rate limits you respect or enforce:
- How a failed call tells you why (auth / rate limit / bad request / timeout):

## 9. Version control and release
- Branching strategy:
- What must pass before merge:
- CI/CD and what it runs:
- Rollback plan:

## 10. Cloud storage and vector data
- File storage (S3 / Supabase Storage / …):
- File types and sizes:
- Embeddings / vector search: what is stored as vectors:
- Vector database:
- RAG pipeline: chunking, embedding, retrieval:

## 11. Prompting (GCIP) — for any LLM feature
- Goal:
- Context:
- Intent:
- Instruction:
- Presentation:

## External documentation needed
List every API, SDK, CLI, MCP server, platform or library this build depends on,
and whether its docs are already saved locally.
- 

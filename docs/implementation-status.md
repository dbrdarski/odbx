# MVP implementation coverage

Authority: [the handover](../odbx-mvp-development-handover.md). Project name: **odbx**,
with O for Oddo. The agreed integration brings the minimal exploratory Oddo runtime
into a separate local module and exports the same constructors to callers.

Work proceeds in bounded batches. **Parser + codec**, **local Oddo runtime**, and
**value stores** are implemented. This checkpoint covers value discovery, counter
forks and mapping rollback through a customizable store factory. Subsequent order:
Documents/Revisions → transactional writes and replay/recovery → public API and
integration. Settled requirements stay in force across all batches.

| Requirement | Status / evidence |
| --- | --- |
| §1, §26: inspect historical mechanisms before implementing | Done for parser/codec, local Oddo runtime and value stores; pinned sources in `parser.md`, `values.md` and `stores.md`; Oddo runtime copied unchanged |
| §4: canonical Oddo Records/Tuples, unordered Record identity, null distinct from absence | Done in `src/values.mjs`, shared constructors exported through `src/index.mjs`; `test/values.test.mjs` |
| §4.3, clarified by Dane: Oddo never produces undefined; JavaScript wrappers normalize host undefined before native construction | Deferred with JavaScript wrappers; no normalization in the Oddo runtime or storage kernel |
| §4, §14: primitive domain, no BigInt value token, no undefined token, `-0` normalization, ordinary NaN | Done for codec/parser and value stores; unsupported host values are rejected without changing Oddo constructors |
| §5, §7–8: String/Tuple/Record stores, canonical-reference Maps, subtree short-circuit, key/value decomposition, child-first discovery | Done in `src/stores.mjs`; references in `src/symbols.mjs`; `test/stores.test.mjs` |
| §5–6, §15–16: first-class Document/Revision stores, numeric IDs, Document type, metadata, timestamp, actual `from` ancestry | Definition syntax done; stores and semantics pending |
| §6–9: fork all counters, journal speculative mappings, failure consumes no IDs, stage publication | Done for value-store forks and mapping rollback in memory; Document/Revision staging and database transaction orchestration pending |
| §9–10, §19: queue covers discovery through publication/rollback, one awaited append, byte offset accounting | Parser byte offsets done; writes pending |
| §9–11: rollback and truncate after partial writes, preserve committed state, block writes after failed recovery | Pending transactions and file adapter |
| §11–12: sequential parser, leading-token dispatch, no full token array, malformed/incomplete suffix detection | Done in `src/parser.mjs`; tests include all digit scalars, invalid UTF-8, string escapes and every-byte truncation |
| §11–12: child-first reconstruction, provisional replay, publish only at valid complete Revision, truncate uncommitted suffix | Complete syntax boundaries exposed; store replay and filesystem recovery pending |
| §12: retain compact grammar, typed reference letters and implicit definition sequence | Done at syntax level; numeric Document identity removes historical UUID field, Tuple roots supported |
| §13, §23.9: radix 63,232, surrogate hole, digit and integer boundaries | Done in `src/codec.mjs`; exhaustive one-digit and large-counter tests |
| §14, §23.8: explicit-endian Float64 codec, finite extremes, infinities, NaN, `-0` | Done; fixed representation fixtures and 4,096 deterministic bit samples |
| §15–19: ancestry/history, archive/restore revisions and metadata duplication, tri-state filtering, committed-only reads | Pending Document/Revision behavior and public API |
| §20: minimal ESM package, built-in Node modules, real test command | Done for this batch; no dependencies |
| §23.1: reuse across saves/documents, descendant traversal stops, provisional child reuse | Value-store tests done across roots and writes in memory; actual document saves pending |
| §23.2–3: counter rollback, retained failed canonical values, correct retry references | Value-store tests done, including injected discovery/output failures and identical retry payloads; file and Document/Revision transaction tests pending |
| §23.4: partial append failures, truncation, ID reuse and next successful transaction | Pending file/transaction tests |
| §23.5: reopen at byte truncations and commit only complete Revisions | Parser truncation tests done; actual reopen/replay tests pending |
| §23.6: chronological latest independent of `from` ancestry | Pending versioning tests |
| §23.7: archive/restore success, failure, data reuse, filters and retained history | Pending archive tests |
| §24–25: prohibitions and architectural invariants | Applied to current batch; full audit remains at integration |

Deferred scope remains as specified in §3.2: plain-JS conversion, proxy mutation,
RPC, JSON reviver integration, schemas/models/relations and indexes, publication,
query DSL, browser adapter, branching workflow, multi-document transactions,
compaction/GC, lazy materialization and replication.

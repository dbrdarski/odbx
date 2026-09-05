# IDBX Rewrite — MVP Development Handover

**Status:** Implementation handover  
**Date:** 2026-09-05  
**Target:** Rewrite the IDBX persistence kernel from scratch while preserving the proven storage ideas of the original repository.  
**Historical implementation:** https://github.com/dbrdarski/idbx  
**Oddo value runtime:** https://github.com/dbrdarski/oddo-next

---

## 1. Authority and implementation rule

This document is the implementation handover for the IDBX MVP.

The old IDBX repository is **historical prior art and the primary source for mechanisms that are explicitly marked KEEP or MODIFY below**. It is not copied wholesale. Where this document differs from the old implementation, this document is authoritative.

The implementation agent must **not redesign settled behavior** merely because a different architecture appears cleaner or more conventional. In particular, do not replace the compact format with JSON/JSONL, do not replace counter stores with hashes/content addresses, do not add SQL/SQLite/LevelDB, do not introduce schemas/models/relations into the MVP, and do not add additional transaction framing that has not been requested.

If an old implementation detail is unclear and this document does not resolve it, inspect the old source before inventing a replacement.

---

## 2. MVP objective

Implement a small, correct, append-only versioned content database whose native values are canonical Oddo Records and Tuples.

The central property is:

> Every revision represents a complete document value, while equal substructures are persisted once and shared across documents and revisions.

Oddo determines live structural identity. IDBX assigns and remembers persistent store IDs for canonical values.

The MVP must prove:

- canonical structural reuse;
- compact child-first persistence;
- numeric document/revision identity;
- revision history and ancestry;
- document archive/restore lifecycle;
- serialized writes;
- failure rollback;
- partial-write truncation;
- deterministic replay to the last complete revision.

---

## 3. Explicit MVP boundary

### 3.1 In scope

- Oddo `Record` and `Tuple` values.
- String, Tuple, Record, Document, and Revision persistent stores.
- Compact old-IDBX-style token format.
- Counter-based IDs/references.
- Numeric Document IDs.
- Numeric Revision IDs.
- Document `type`.
- Revision metadata including `timestamp`, `from`, and archive state as in the old simplified metadata model.
- Document archive/restore as soft deletion represented through revisions.
- Recursive discovery of only values not yet persisted.
- One collected output buffer per save.
- One serialized write transaction at a time.
- Forked counters.
- Speculative persistent-map entries with rollback.
- One awaited file append per transaction.
- Last committed byte offset and truncation after partial write failure.
- Replay/recovery where a complete Revision is the logical commit boundary.
- Minimal read/version APIs needed for documents and revisions.

### 3.2 Explicitly out of scope

Do not implement any of the following in the MVP:

- recursive plain-JS object/array wrapper;
- proxy mutator;
- RPC integration;
- `JSON.parse(..., reviver)` integration;
- schemas;
- models;
- relations/associations;
- relation indexes;
- draft/published workflow;
- publication model;
- general lazy query DSL;
- browser persistence adapter;
- branching UI/workflow;
- multi-document transactions;
- compaction/GC;
- lazy disk-backed materialization;
- replication/distributed identity.

The plain-JS recursive constructor and proxy mutator are first in line after the MVP, but they are separate value-layer helpers and must not leak into the storage kernel.

---

## 4. Native value semantics

### 4.1 Oddo owns structural canonicalization

IDBX receives values that are already in the Oddo canonical value universe.

Current Oddo semantics:

- Records are canonical unordered mappings: Record key order does not affect identity.
- Tuples are canonical ordered sequences.
- Children are expected to already be canonical/primitive when a Record/Tuple is constructed.
- Structural cycles are not supported by IDBX.

IDBX must not perform general deep-equality matching for Records/Tuples. Canonical object reference is already the proof of structural identity in the live runtime.

### 4.2 Primitive domain

MVP persistent value domain:

- `null`;
- Boolean;
- Number;
- String;
- Tuple;
- Record.

**BigInt is removed**, matching the current Oddo design.

### 4.3 `undefined`

`undefined` is not a separate persistent IDBX value inside Records/Tuples.

Oddo Record/Tuple construction must normalize an encountered `undefined` child to `null` before interning. Therefore:

```js
Record({ a: undefined }) === Record({ a: null })
Tuple(undefined) === Tuple(null)
```

Field absence remains distinct:

```js
Record({}) !== Record({ a: null })
```

IDBX therefore needs only the existing `V`/void-like primitive representation for the normalized `null` value; it does not need a second `undefined` token.

### 4.4 `-0`

IDBX normalizes `-0` to `+0` before Number encoding:

```js
if (Object.is(value, -0)) value = 0
```

This is a persistence normalization only. No larger number-semantic subsystem is required.

### 4.5 NaN

Do not add special NaN canonicalization machinery for the MVP.

Oddo's primitive interning already treats NaN as one key under JavaScript `Map` semantics. IDBX is currently a single-server design. Persist NaN through the normal Float64 encoding used by the runtime.

---

## 5. Persistent store set

Preserve the original architecture as five first-class stores, renamed where the semantic role changed:

```text
StringStore
TupleStore       // old ArrayStore role
RecordStore      // old ObjectStore role
DocumentStore
RevisionStore    // old recordStore/top-level record role
```

Documents and Revisions remain stores. Do not collapse them into generic maps or remove their persistent representation.

### 5.1 Store responsibilities

#### StringStore

Stores/deduplicates strings and returns compact String references.

Preserve old behavior conceptually.

#### TupleStore

Stores canonical Oddo Tuples. Persistent lookup is by canonical Tuple object reference.

A hit returns the existing Tuple store ID immediately and terminates traversal of that subtree.

A miss recursively ensures its children, then serializes the Tuple definition child-first.

#### RecordStore

Stores canonical Oddo Records. Persistent lookup is by canonical Record object reference.

Preserve the old object decomposition:

```text
Record
  -> canonical keys Tuple
  -> canonical values Tuple
```

The Record definition references those two Tuples.

Because Oddo Record keys are already canonicalized into deterministic unordered-record order, persistent Record decomposition must use that same order.

#### DocumentStore

Preserve the old first-class Document concept:

```js
{
  id,
  type
}
```

The semantic change is that `id` is numeric/counter-based rather than UUID-based.

Document type remains part of the core Document representation. The removal of schemas/models from the MVP does **not** remove Document type.

#### RevisionStore

This is the renamed semantic role of the old top-level `recordStore`.

A Revision is a historical event, not a structurally deduplicated content value.

A Revision connects:

- its numeric revision identity;
- Document reference;
- metadata Record reference;
- data root reference;
- document archive state.

The Revision is the final logical entry of every transaction.

---

## 6. IDs and counters

### 6.1 Documents

Document IDs are numeric counter IDs:

```text
1, 2, 3, ...
```

No UUID generation in the rewrite.

### 6.2 Revisions

Revision IDs are an independent numeric counter namespace:

```text
1, 2, 3, ...
```

No UUID generation in the rewrite.

### 6.3 Value-store references

Preserve the old counter/reference-store philosophy for String/Tuple/Record/etc. Exact internal counter objects should remain store-local.

### 6.4 Counter transactionality

Every counter that can advance during a save is forked before transaction discovery begins.

Committed counters are not advanced during speculative discovery.

On success, forked counters replace committed counters.

On failure, forked counters are discarded.

**Invariant:** a failed transaction consumes no persistent IDs.

---

## 7. Canonical value -> persistent ID maps

### 7.1 Use `Map`, not `WeakMap`

For canonical composite values, use ordinary `Map` keyed by canonical Record/Tuple reference.

Conceptually:

```js
const tupleIds = new Map()
const recordIds = new Map()
```

The database is append-only and fully resident in the MVP. Persisted values are intentionally retained, so WeakMap lifetime semantics provide no useful benefit.

### 7.2 Meaning of a hit

A hit means:

> This canonical value is already persisted in this database.

Therefore:

```text
Map hit
-> return existing store ID
-> do not inspect children
-> emit nothing
```

This is the primary runtime benefit of integrating Oddo canonical identity with IDBX persistence.

### 7.3 Meaning of a miss

A miss starts recursive persistence discovery for that value.

New mappings may be inserted eagerly into the normal persistent Map so the same new canonical value encountered later in the current transaction resolves to the same provisional ID.

Every speculative insertion must simultaneously be recorded in the transaction rollback journal.

---

## 8. Recursive discovery and transaction output

Preserve the central old-IDBX `getKey(write)(value)` idea:

> get existing persistent ID, or recursively create every missing dependency and queue new definitions before returning the newly allocated ID.

The rewritten algorithm differs in lookup mechanism and transaction safety, not in traversal shape.

For a Tuple/Record miss:

1. Recursively ensure child values.
2. Allocate the provisional store ID from the forked counter.
3. Insert canonical-value -> provisional-ID into the store Map.
4. Record the inserted key/store in the rollback journal.
5. Serialize the new definition into the transaction output queue.
6. Return the provisional ID.

The queue is naturally child-before-parent.

Example:

```text
new strings/primitive references
new child Tuples
new child Records
new parent Tuple/Record
Document definition if required
revision metadata Record if new
final Revision
```

The complete queue is joined/encoded into one transaction payload before file I/O begins.

---

## 9. Write transaction lifecycle

### 9.1 Serialized write queue

At most one write transaction may be in preparation/write/publication/rollback at a time.

The queue covers the **whole transaction**, not merely `adapter.write`.

A later write must never observe speculative IDs/mappings created by an earlier uncommitted write.

### 9.2 Transaction state

A transaction needs at least:

```text
forked counters
created/speculative mapping journal
output definitions
provisional Document/Revision state
start file offset
```

Do not publish Document/Revision state into committed indexes during discovery.

### 9.3 Success path

After the complete transaction payload has been written successfully:

1. Keep the speculative value->ID Map entries; they are now committed.
2. Replace committed counters with the transaction counter forks.
3. Publish the new Document if this was a create.
4. Publish the Revision.
5. Update the Document's revision history/latest state/archive state.
6. Advance `committedEndOffset` by the actual encoded byte length.
7. Resolve the save promise.

### 9.4 Failure path

If the write rejects:

1. Delete every speculative value->ID Map entry recorded in the rollback journal.
2. Discard all forked counters.
3. Publish no new Document.
4. Publish no Revision.
5. Leave the committed Document/revision indexes unchanged.
6. Truncate the file back to the transaction's captured start offset.
7. Leave `committedEndOffset` unchanged.
8. Reject the save promise.

If truncation/recovery itself fails, the instance must not continue accepting writes against an unknown physical suffix.

---

## 10. File offset and one-write rule

Maintain:

```js
let committedEndOffset
```

This is the byte offset immediately after the last successfully committed transaction and the starting position of the next transaction.

Before a write:

```js
const startOffset = committedEndOffset
```

All entries for one revision transaction are written in **one logical adapter write**. The final Revision is not written in a separate call.

On failure, truncate to `startOffset`.

Offsets are byte offsets, not JavaScript UTF-16 string lengths.

---

## 11. Replay and recovery

Preserve the old append/replay model, but make replay transactional.

After the last accepted Revision, parsed definitions belong to a provisional replay transaction.

Only when a complete Revision entry parses successfully is that pending group accepted as committed.

At that point:

- accept its store/counter advances;
- reconstruct/publish its Document and Revision state;
- update the last committed byte offset to the position after the Revision.

If EOF or malformed trailing data occurs before a complete Revision:

- discard the provisional replay transaction;
- keep the previously committed stores/counters/indexes;
- retain the previous committed offset;
- truncate the incomplete physical suffix before accepting future writes.

No extra checksum, frame-length wrapper, JSONL envelope, or file header is part of the current MVP design.

---

## 12. Compact token format

### 12.1 KEEP the old grammar architecture

Do not redesign the persistent language.

Old grammar roles are preserved:

```text
"..."   String definition
[...]   Tuple definition      // old Array definition role
{...}   Record definition     // old Object definition role
<...>   Document definition
(...)   Revision definition   // old top-level record role

S...    String reference
A...    Tuple reference       // existing A token may remain
O...    Record reference      // existing O token may remain
D...    Document reference
R...    Revision reference

T       true
F       false
V       null
N...    Number
```

The old BigInt `+...` / `-...` value forms are removed because BigInt is no longer in the value model.

The implementation may keep the historical `A`/`O` token letters even though runtime names are now Tuple/Record. Do not churn the format merely for naming aesthetics.

### 12.2 KEEP child-first implicit counter semantics

Definitions establish store entries in sequence; typed references point to those store IDs.

### 12.3 MODIFY the parser implementation

Drop the old generic regex tokenizer algorithm that repeatedly searches every regex against the remaining string and materializes a full token array.

Replace it with a deterministic scanner/parser for the same compact grammar.

The parser must:

- dispatch from known leading syntax/token characters;
- parse sequentially;
- reconstruct children before parents;
- track byte position;
- support provisional replay state between Revision boundaries;
- detect malformed/incomplete trailing input;
- never publish an incomplete Revision transaction.

---

## 13. Compact integer/reference encoding

### 13.1 KEEP the old high-radix design

Old IDBX reserves code units `0..255` for syntax and uses the higher UTF-16 region for compact ID digits.

Preserve that idea.

### 13.2 MODIFY only the unsafe digit alphabet

The old range `U+0100..U+FFFF` includes the UTF-16 surrogate block:

```text
U+D800..U+DFFF
```

Those code units are not valid standalone Unicode scalar values when the JS string is encoded as UTF-8.

Use two valid physical ranges:

```text
U+0100..U+D7FF
U+E000..U+FFFF
```

The surrogate block is skipped as one contiguous hole.

Logical digit space remains contiguous:

```text
0..63231
```

New radix:

```text
63,232
```

The digit encoder maps logical digits below the hole directly and adds `0x800` after the hole. The decoder reverses this mapping and rejects surrogate code units.

Do not replace the scheme with base64/base85/varints for the MVP.

---

## 14. Number encoding

### 14.1 KEEP the old model

Preserve:

```text
Number
-> IEEE-754 Float64 bits
-> integer
-> compact integer encoder
```

### 14.2 MODIFY `-0`

Normalize:

```text
-0 -> +0
```

before extracting Float64 bits.

### 14.3 MODIFY host-layout dependence

The old implementation reinterprets `Float64Array` memory through `Uint32Array`, which depends on host byte layout.

Use an explicit-endian `DataView` implementation for the same 64-bit bit-preserving representation.

BigInt may be used internally by the codec as an implementation type for manipulating 64 bits; this does **not** reintroduce BigInt as an IDBX data value.

### 14.4 NaN

Do not add a special NaN canonicalization layer in the MVP. Encode the runtime's normal Float64 NaN representation.

---

## 15. Revision/version model

### 15.1 Revision identity

Revision ID is the RevisionStore's numeric counter identity rather than a UUID stored as ordinary metadata.

Do not redundantly persist information that can be derived from the RevisionStore entry/counter unless the old design deliberately duplicates it for convenience.

### 15.2 `from` MUST be preserved

`from` records the ancestor Revision from which the new Revision was created.

It is **not** redundant chronological information.

Example:

```text
R1 -> R2 -> R3 -> R4
       \
        -> R5
```

If R5 was created by taking R2 and editing/republishing from there:

```text
R5.from = R2
```

R5 may be chronologically newer than R4 while still descending from R2.

This lineage is a historical fact and belongs in revision metadata.

### 15.3 Revision metadata

Preserve the old simplification: metadata itself is stored using the ordinary Record/value machinery and the public/in-memory revision can derive/reconstruct fields from the surrounding Revision entry.

MVP metadata retains the old useful concepts:

- `timestamp`;
- `from`;
- `archived` where the old metadata representation keeps it for convenience.

`user` is not an MVP feature. The old code hard-coded it and never implemented a real user source.

`published` / draft state is removed from the MVP and should not be recreated in the base model.

### 15.4 Final Revision entry

Preserve the old top-level structure conceptually:

```text
Revision(
  DocumentRef,
  MetadataRecordRef,
  DataRootRef,
  ArchivedState
)
```

Archive state may also exist in metadata for convenience; do not remove that duplication simply for normalization.

---

## 16. Document model

### 16.1 KEEP old semantic structure

Document remains:

```js
{
  id,
  type
}
```

with a counter-based numeric `id` replacing UUID.

Document type remains core data.

### 16.2 Document creation

A new Document and its first Revision are one persistence transaction.

The new Document must not become visible in committed in-memory state before the transaction write succeeds.

On failure, its provisional counter allocation is discarded and the Document is not published.

---

## 17. Archive semantics

### 17.1 Meaning

`archived` is **Document state**, i.e. document-level soft deletion.

It is recorded in revision data because every Revision preserves what the Document state became at that historical point.

### 17.2 Archive/restore behavior

Archiving or restoring creates another Revision. History is never physically deleted.

An archive-only or restore-only Revision can reuse the exact same data root as the prior Revision.

### 17.3 Preserve metadata duplication

The old implementation duplicates archive information between convenient revision metadata and the top-level Revision data.

This is intentional convenience, not a normalization bug to remove in the MVP.

### 17.4 Filtering

For document-selection/current-document APIs, preserve tri-state archive filtering:

```js
archived: false // active documents only; normal/default collection view
archived: true  // archived documents only
archived: null  // all documents regardless of archive state
```

Exact historical Revision access must remain possible. Do not make archive soft deletion erase history.

---

## 18. API direction

Do not perform a new API-design project before implementing the persistence MVP.

Preserve the old vocabulary where it still maps cleanly:

```js
DB.create(...)
DB.open(...)

db.save(...)
db.latest(...)
db.revision(...)
db.revisions(...)
```

`save` remains a good name because every modification creates a Revision rather than destructively updating a row.

Archive/restore convenience methods may be thin wrappers over `save` using the existing data root and appropriate archive state/`from` ancestry.

The old general query DSL is not part of the MVP. Basic methods may return direct values/collections rather than recreating `iterable.js`/`query-item.js` machinery.

---

## 19. Read/write scheduling

### Writes

All writes are serialized through one queue covering preparation through publish/rollback.

A rejected transaction must not poison the queue after rollback/truncation completes.

### Reads

Reads expose only committed state.

There is no extra read queue requirement. If a caller needs read-after-write behavior, it awaits `db.save(...)` before reading.

---

# 20. Old repository component migration map

This section is the primary code-level handover.

---

## `src/helpers.js`

### Status: **MODIFY heavily; preserve the store/get-or-create pattern**

### KEEP

- `createStore` / store-local encapsulation concept.
- `getValue` / `getKey` conceptual dual lookup.
- Per-store counters.
- `fork` concept for transactional counter state.
- `serializeObject` conceptual decomposition into keys and values.

### MODIFY

- Replace old serialized-string/object-property structural matching for Record/Tuple with `Map` keyed by canonical Oddo Record/Tuple reference.
- Use normal Map-based backing stores where appropriate instead of `Object.create` lookup tables.
- Forked counters must begin from the committed counter value, not reset to zero.
- Transaction discovery may eagerly add speculative canonical-value->ID mappings, but every such insertion must enter the transaction rollback journal.
- `generateUUID` is removed.
- Record key/value decomposition now operates on canonical unordered Oddo Records.

### REMOVE

- UUID global set/generator.
- Prototype-chain store inheritance as a substitute for correct transaction rollback.

### Critical warning

The old `fork()` implementation inherits maps but starts `counter = 0n`; do not copy that behavior.

---

## `src/stores.js`

### Status: **KEEP architecture; rewrite implementation around Oddo and transactions**

### KEEP

- Separate String / collection / object / Document / top-level Revision store architecture.
- String interning.
- Tuple child-first serialization.
- Record decomposition into keys Tuple + values Tuple.
- Document `{ id, type }` concept.
- Final top-level Revision containing Document, metadata, data root, archive state.
- Generic `matchType`/type-dispatch concept.
- Replay reconstructing stores from token definitions/references.

### MODIFY

- `arrayStore` becomes TupleStore semantically.
- `objectStore` becomes RecordStore semantically.
- Tuple/Record persistent lookup uses canonical object reference Maps.
- Records use Oddo's unordered canonical key order.
- `documentStore` uses numeric Document IDs rather than UUID strings.
- `recordStore` becomes RevisionStore with numeric Revision IDs.
- BigInt value handling is removed.
- `undefined` is expected to have already normalized to null inside canonical Oddo values.
- `-0` normalization occurs in number encoding.
- Remove all schema/model/relations hooks from persistence (`initModels`, `selectModel`, `validate`, `createRecord`, `releaseModel`, etc.).
- Do not mutate committed Document/revision indexes while serializing. Stage those effects until write success.

### REMOVE from MVP

- `initModels` dependency.
- `$or` dependency.
- schema validation from save path.
- relation/model lifecycle calls.
- publication/draft state.
- UUID generation.

---

## `src/db.mjs`

### Status: **KEEP repository/create/open/save shape; rewrite transaction control**

### KEEP

- `repository(adapter)` factory concept.
- `ContentRepository` instance per file.
- `create` and `open` entry points.
- `save` constructing one complete output collection before adapter write.
- replay/load as reconstruction from the append-only file.

### MODIFY

- `save` becomes async and **must await** the adapter write.
- Add one serialized write queue.
- Capture `committedEndOffset` before each transaction.
- Fork counters before discovery.
- Track speculative Map insertions.
- Publish Document/Revision state only after awaited write success.
- On failure: rollback mappings, discard forks, truncate file to transaction start offset, reject.
- `load` must propagate unrecoverable parse/open errors rather than merely `console.error` them.
- Replay must commit only through complete Revision boundaries.

### REMOVE from MVP

- `runQuery` integration.
- schema export.
- middleware/RPC export.
- hard-coded `user` metadata.
- `publish` parameter and published/draft state.

---

## `src/utils.js`

### Status: **KEEP codec core; split/trim unrelated utilities**

### KEEP

- compact integer codec concept.
- Float64 -> integer -> compact-int encoding concept.
- small generic helpers only if still used by the persistence kernel.

### MODIFY

- integer digit alphabet skips `U+D800..U+DFFF`, giving radix 63,232.
- decoder rejects surrogate-code-unit digits.
- Float64 conversion uses explicit-endian `DataView` rather than host-layout typed-array reinterpretation.
- normalize `-0` to `+0` before encoding.
- type dispatch recognizes Oddo Tuple/Record rather than arbitrary Array/Object for native MVP persistence.
- BigInt as a user-stored value type is removed; BigInt may remain as an internal arithmetic implementation type.

### REMOVE from core/MVP

- DOM/VNode utilities (`getVNodeTree`, `createElement`, `render`).
- stale experimental utilities not used by persistence.
- UUID-related logic lives nowhere in new MVP.

---

## `src/symbols.js`

### Status: **KEEP typed-reference abstraction; adapt codec/value names**

### KEEP

- Type-specific compact reference wrapper concept.
- `N`, `S`, `A`, `O`, `D`, `R` token/reference distinction.
- conversion between store counters and encoded compact IDs.

### MODIFY

- underlying `encodeInt` uses the safe 63,232 radix mapping.
- Number encoding uses revised Float64 codec.
- `ArraySymbol`/`ObjectSymbol` may keep `A`/`O` persistent letters while runtime code refers to TupleStore/RecordStore.
- BigInt/Integer value-token support is removed from the persistent value domain.

### DO NOT

Do not rename persistent token letters merely to make them spell Tuple/Record unless there is a demonstrated need.

---

## `src/parser/tokenizer.js`

### Status: **REPLACE parser implementation; KEEP grammar**

### KEEP

- token/definition grammar.
- delimiter meanings.
- typed references.
- final Revision entry grammar role.

### REMOVE

- generic regex-search tokenizer algorithm.
- full token-array materialization as a prerequisite to replay.

### REPLACE WITH

A deterministic sequential parser/scanner that parses the existing compact language directly and supports provisional replay state between Revision boundaries.

---

## `src/getters.js`

### Status: **SIMPLIFY heavily**

### KEEP

- per-Document revision history.
- latest Revision pointer/state.
- current Document archive state.
- lookup by Document ID and Revision ID.
- basic `latest`, `revision`, `revisions` concepts.

### MODIFY

- use Map-based indexes rather than old plain-object tables where appropriate.
- Document/revision state is published only after persistence succeeds.
- archive document filtering supports `false` / `true` / `null` semantics.
- exact historical Revision access remains available.

### REMOVE from MVP

- `publications` store/index.
- `drafts` store/index.
- published/draft mode switching.
- query relationship integration.
- dependency on `iterable.js` and `query-item.js` if basic direct methods suffice.

### Note

The old file contains an incomplete/broken `ids` path in `revisions`; do not preserve incidental bugs while preserving the intended version/history structure.

---

## `src/models.js`

### Status: **REMOVE from MVP**

Do not port.

The module couples getters, schema validation, and relations. Those layers are explicitly deferred.

Document `type` still remains in core despite models being absent.

---

## `src/schema.js`

### Status: **REMOVE from MVP / preserve only as future prior art**

Do not port into the storage kernel.

Schemas may return later as an optional composable layer.

---

## `src/relations.js`

### Status: **REMOVE from MVP / preserve as future prior art**

Do not port.

Important future finding to retain conceptually:

- relation targets can remain ordinary Document IDs inside persisted Records/Tuples;
- inverse associations can later be derived by an optional layer;
- no core Ref type is required for the MVP.

---

## `src/query.js`, `src/iterable.js`, `src/query-item.js`

### Status: **REMOVE from MVP**

Do not port the general query DSL.

Implement only the direct document/revision reads necessary for the MVP.

---

## `src/middleware.js`

### Status: **REMOVE from MVP**

RPC/network integration is explicitly deferred.

---

## `src/adapters/ascii.js`

### Status: **KEEP minimal adapter idea; MODIFY for transaction recovery**

### KEEP

- extremely small filesystem abstraction.
- create/open/append semantics.

### MODIFY

- all async operations are awaited.
- add truncation by byte offset.
- expose enough information to maintain/update `committedEndOffset` correctly.
- write accepts/uses the exact transaction payload built before I/O.

### DO NOT ADD

- database-engine dependencies;
- SQL;
- key-value engine;
- unnecessary adapter framework hierarchy.

---

## Browser adapter / browser development code

### Status: **REMOVE from MVP**

Browser persistence was an early development convenience and is not part of the initial rewrite target.

---

## Package/build metadata

### Status: **CLEAN UP**

- ESM remains appropriate.
- remove the `fs` npm placeholder dependency; use Node's built-in filesystem modules.
- add a real test command.
- do not carry Parcel/browser build dependencies into the core MVP unless a separate development need requires them.

---

# 21. Suggested new MVP source layout

This is a mapping suggestion, not a new architectural layer. Keep it small.

```text
src/
  db.mjs             // repository instance, queue, transaction orchestration
  stores.mjs         // String/Tuple/Record/Document/Revision stores
  codec.mjs          // safe compact integers + Float64 encoding
  symbols.mjs        // typed compact references
  parser.mjs         // deterministic compact-stream parser/replay
  getters.mjs        // minimal committed document/revision indexes and reads
  adapters/
    file.mjs         // create/open/append/truncate
```

Tests:

```text
test/
  codec.test.mjs
  stores.test.mjs
  transaction.test.mjs
  recovery.test.mjs
  versioning.test.mjs
  archive.test.mjs
```

Do not reproduce the old module split when a module only existed for a deferred feature.

---

# 22. Implementation sequence

## Phase 1 — Codec compatibility/fixes

Implement and test:

- safe high-radix integer mapping with surrogate hole;
- encode/decode counter round trips;
- Float64 encode/decode using explicit endian;
- `-0 -> 0` persistence normalization;
- strings and primitive tokens.

Do not change grammar architecture.

## Phase 2 — Core value stores

Implement:

- StringStore;
- TupleStore;
- RecordStore;
- canonical-reference Map lookup;
- child-first recursive discovery;
- Record keys/value Tuple decomposition;
- counters and counter forks;
- speculative-map rollback journal.

Test without filesystem first.

## Phase 3 — Document and Revision stores

Implement:

- numeric Document IDs + type;
- numeric Revision IDs;
- metadata Record persistence;
- `from` ancestry;
- timestamp;
- archive state;
- basic committed indexes/history.

## Phase 4 — Transactional file write

Implement:

- serialized write queue;
- one payload per transaction;
- awaited append;
- `committedEndOffset`;
- publish-on-success;
- rollback + truncate on failure.

## Phase 5 — Replay/recovery parser

Implement deterministic sequential parser for the existing compact grammar.

Replay into provisional transaction state and accept only on complete Revision.

Recover last committed byte offset.

## Phase 6 — Minimal public API

Implement the old-style direct vocabulary needed by MVP:

- create/open;
- save;
- latest;
- revision;
- revisions;
- archive/restore convenience if retained as public helpers.

Do not implement the old query DSL.

---

# 23. Required correctness tests

## 23.1 Canonical persistence

- same canonical Tuple saved twice -> one Tuple definition;
- same canonical Record saved twice -> one Record definition;
- repeated child shared across unrelated documents -> one persistent child;
- persisted child Map hit prevents descendant traversal;
- same new child encountered multiple times in one transaction gets one provisional ID.

## 23.2 Counter rollback

Inject write failure after complete discovery.

Verify:

- committed counters unchanged;
- speculative Map entries removed;
- failed Document ID is reusable;
- failed Revision ID is reusable;
- retry emits references matching replayed IDs.

## 23.3 Retained failed values

Caller retains the canonical Record/Tuple used by a failed transaction.

Verify retry does **not** hit an incorrect stale persistent ID. This proves rollback does not depend on GC/WeakMap behavior.

## 23.4 Partial write

Inject failure after writing arbitrary byte prefixes of a complete transaction payload.

Verify:

- save rejects;
- memory rolls back;
- file truncates to prior `committedEndOffset`;
- next transaction succeeds with correct IDs.

## 23.5 Replay boundaries

Truncate a valid file at many positions between one Revision and the next.

Verify only complete Revisions become committed after reopen.

## 23.6 Revision ancestry

Create R1 -> R2 -> R3, then create R4 from R1.

Verify:

- R4 is chronologically latest;
- `R4.from === R1.id`;
- R2/R3 remain in history;
- ancestry is not inferred merely from chronological order.

## 23.7 Archive

- archive creates a new Revision;
- archive-only revision can reuse same data root;
- current Document archived state updates only after successful write;
- failed archive leaves current state unchanged;
- restore creates a later Revision;
- `archived: false`, `true`, and `null` select active, archived, and all documents respectively;
- historical revisions remain accessible.

## 23.8 Number codec

- normal finite numbers round trip;
- infinities round trip if supported by current Number codec;
- `-0` persists/reloads as `+0`;
- NaN round trips as NaN;
- codec round trips on the target Node runtime.

## 23.9 Integer codec

Test around all important boundaries:

- 0;
- 255/256 syntax boundary is irrelevant to logical digit space but verify generated physical code units start at U+0100;
- final digit before surrogate hole maps to U+D7FF;
- next digit maps to U+E000;
- no encoder output ever contains U+D800..U+DFFF;
- maximum one-digit logical value;
- multi-digit IDs across radix boundaries.

---

# 24. Explicit implementation prohibitions

The implementation agent must not:

- replace the compact format with JSON or JSONL;
- add checksums/frame lengths/file headers without a newly approved requirement;
- add SQLite/LevelDB/another database engine;
- introduce hashes/content-addresses as the primary ID scheme;
- remove DocumentStore;
- remove Document `type`;
- remove RevisionStore;
- drop `from` ancestry;
- normalize away archive duplication that exists for convenience;
- reintroduce published/draft state;
- reintroduce BigInt as a stored value type;
- add an `undefined` persistent token; undefined is normalized to null before interning;
- add schemas/models/relations/RPC/mutator/plain-JS wrapper to MVP;
- use WeakMap for the persistent canonical composite -> ID store;
- advance committed counters before write success;
- publish Documents/Revisions before write success;
- let an unawaited adapter write escape from `save`;
- continue writes after truncation/recovery failure.

---

# 25. Architectural invariants

The implementation is correct only if all of these remain true.

1. Oddo canonical identity defines live Record/Tuple equality.
2. One committed canonical Record/Tuple has one persistent ID per store/database instance.
3. A committed persistent Map hit ends traversal of that subtree.
4. New definitions are emitted child-before-parent.
5. Revisions are the final logical transaction entries.
6. Document and Revision IDs are counter-based numeric identities.
7. Document `type` remains persisted.
8. `from` records actual ancestor Revision, not merely chronological predecessor.
9. Archive is Document state preserved historically through Revisions.
10. A failed transaction consumes no persistent IDs.
11. A failed transaction leaves no speculative Map mappings.
12. A failed transaction publishes no Document/Revision state.
13. A failed partial file append is truncated to the prior committed byte offset.
14. Replay accepts no transaction lacking a complete final Revision.
15. At most one write transaction is active at a time.
16. Reads expose committed state only.
17. The old compact grammar architecture remains the persistent format.

---

# 26. Historical source guide

Use these old files as implementation references, subject to the KEEP/MODIFY/REMOVE rules above:

- `src/helpers.js` — store/get-or-create mechanism and old fork concept.
- `src/stores.js` — String/Array/Object/Document/top-level Record stores; child-first serialization; metadata/data/document assembly.
- `src/db.mjs` — one-output-array save shape and create/open lifecycle; also contains the unawaited-write bug to fix.
- `src/utils.js` — compact integer and Float64 codecs.
- `src/symbols.js` — typed reference wrappers.
- `src/parser/tokenizer.js` — authoritative old token grammar, but **not** the parser architecture to copy.
- `src/getters.js` — old Document/revision/history/archive bookkeeping; strip publication/draft/query complexity.
- `src/schema.js`, `src/models.js`, `src/relations.js` — deferred-layer prior art only; do not port to MVP.
- `src/query.js`, `src/iterable.js`, `src/query-item.js` — old query DSL; do not port to MVP.
- `src/adapters/ascii.js` — minimal filesystem adapter idea; add awaited writes/truncate.

---

# 27. Final implementation summary

The rewrite is **not a new database design**.

It is a disciplined rewrite of the strongest original IDBX persistence ideas around the new Oddo canonical value runtime:

```text
Oddo canonical Record/Tuple
        |
        v
persistent Map lookup
  hit --------> reuse ID, stop
  miss
        |
        v
recursive child-first discovery
        |
        v
provisional IDs from forked counters
        |
        v
speculative Map entries + rollback journal
        |
        v
compact old-IDBX-style definitions
        |
        v
Document / metadata / data
        |
        v
final Revision
        |
        v
one awaited append
     /       \
 success     failure
   |           |
keep maps    delete speculative maps
publish      discard counter forks
counters     publish nothing
doc/rev      truncate file
advance      reject
file offset
```

Everything above this kernel—plain-JS conversion, proxy mutation, RPC, schemas, relations, models, publication—is deliberately deferred.

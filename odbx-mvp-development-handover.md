# odbx — MVP Development Handover

**Status:** MVP implemented; reconciled design and API record
**Date:** 2026-09-10
**Target:** Preserve the proven storage ideas of the original IDBX repository in the implemented odbx persistence kernel.
**Historical implementation:** https://github.com/dbrdarski/idbx  
**Oddo value runtime:** https://github.com/dbrdarski/oddo-next

---

## 1. Authority and implementation rule

This document records the implemented odbx MVP and the decisions made during
the parser, value-runtime, store, Document, Revision, transaction, replay, and
public API slices.

The old IDBX repository is **historical prior art and the primary source for mechanisms that are explicitly marked KEEP or MODIFY below**. It is not copied wholesale. Where this document differs from the old implementation, this document is authoritative.

The implementation agent must **not redesign settled behavior** merely because a different architecture appears cleaner or more conventional. In particular, do not replace the compact format with JSON/JSONL, do not replace value-store counters with content addresses, do not add SQL/SQLite/LevelDB, do not introduce schemas/models/relations into the MVP, and do not add additional transaction framing that has not been requested.

If an old implementation detail is unclear and this document does not resolve it, inspect the old source before inventing a replacement.

Do not add or modify tests without explicit user permission. Approved new tests
must be unit tests. Functionality belongs in `src`, never in test helpers or
fixtures. The existing parser unit tests are already approved.

---

## 2. MVP objective

The MVP is a small, correct, append-only versioned content database whose native
values are canonical Oddo Records and Tuples.

The central property is:

> Every revision represents a complete document value, while equal substructures are persisted once and shared across documents and revisions.

Oddo determines live structural identity. odbx assigns and remembers compact
store reference strings for canonical values.

The MVP must prove:

- canonical structural reuse;
- compact child-first persistence;
- random opaque Document/Revision identity;
- revision history and ancestry;
- document archive/restore lifecycle;
- serialized writes;
- failure rollback;
- recovery from partial writes without advancing the committed file position;
- deterministic replay to the last complete revision.

---

## 3. Explicit MVP boundary

### 3.1 In scope

- Oddo `Record` and `Tuple` values.
- String, Tuple, Record, Document, and Revision persistent stores.
- Compact old-IDBX-style token format.
- Counter-based persistent store references.
- Random opaque Document IDs.
- Random opaque Revision IDs.
- Document `type`.
- Internally generated Revision metadata containing exactly `id`, `timestamp`, `archived`, and `from`.
- Document archive/restore as soft deletion represented through revisions.
- Recursive discovery of only values not yet persisted.
- One collected output payload per Revision transaction.
- One serialized write transaction at a time.
- Forked counters.
- Speculative persistent-map entries with rollback.
- Positioned file writes beginning at the last committed byte offset.
- An unchanged committed position after write failure, allowing the next write to overwrite an incomplete suffix.
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

odbx receives values that are already in the Oddo canonical value universe.

Current Oddo semantics:

- Records are canonical unordered mappings: Record key order does not affect identity.
- Tuples are canonical ordered sequences.
- Children are expected to already be canonical/primitive when a Record/Tuple is constructed.
- Structural cycles are not supported by odbx.

odbx must not perform general deep-equality matching for Records/Tuples. Canonical object reference is already the proof of structural identity in the live runtime.

### 4.2 Primitive domain

MVP persistent value domain:

- `null`;
- Boolean;
- Number;
- String;
- Tuple;
- Record.

**BigInt is removed**, matching the current Oddo design.

A Document body is always a Record. Tuples remain valid as nested values inside
that Record, but a Revision cannot use a Tuple or primitive as its data root.

### 4.3 `undefined`

Oddo is a separate language and never produces an `undefined` value. Its
Record/Tuple construction and canonical identity semantics remain unchanged.

The Oddo source repository remains unchanged. odbx's local runtime copy adds
cached `Record.keys(record)` and `Record.values(record)` helpers for persistence
decomposition. Each helper returns a canonical Tuple and calculates it at most
once per Record. These helpers do not alter Record construction or identity.

JavaScript-facing wrappers are responsible for normalizing host `undefined`
children to `null` before passing them to the native constructors. A present JS
property or Tuple element containing `undefined` becomes `null`; an absent field
remains absent. This belongs to the JavaScript integration helpers deferred in
§3.2, not to the Oddo runtime or persistence kernel.

Native field absence remains distinct from null:

```js
Record({}) !== Record({ a: null })
```

odbx therefore needs only the existing `V`/void-like primitive representation for
`null`; `undefined` is not a persistent value and does not get a separate token.

### 4.4 `-0`

odbx normalizes `-0` to `+0` before Number encoding:

```js
if (Object.is(value, -0)) value = 0
```

This is a persistence normalization only. No larger number-semantic subsystem is required.

### 4.5 NaN

Do not add special NaN canonicalization machinery for the MVP.

Oddo's primitive interning already treats NaN as one key under JavaScript `Map` semantics. odbx is currently a single-server design. Persist NaN through the normal Float64 encoding used by the runtime.

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

Stores/deduplicates strings and returns compact String reference strings.

Preserve old behavior conceptually.

#### TupleStore

Stores canonical Oddo Tuples. Persistent lookup is by canonical Tuple object reference.

A hit returns the existing Tuple reference string immediately and terminates
traversal of that subtree.

A miss recursively ensures its children, then serializes the Tuple definition child-first.

#### RecordStore

Stores canonical Oddo Records. Persistent lookup is by canonical Record object reference.

Preserve the old object decomposition:

```text
Record
  -> canonical keys Tuple
  -> canonical values Tuple
```

The Record definition references those two Tuples. Use the cached
`Record.keys(record)` and `Record.values(record)` helpers. Do not reconstruct
them with `Tuple(...Object.keys(record))` or
`Tuple(...Object.values(record))` during each write.

Because Oddo Record keys are already canonicalized into deterministic unordered-record order, persistent Record decomposition must use that same order.

#### DocumentStore

Preserve the old first-class Document concept:

```js
{
  id,
  type
}
```

`id` is a random opaque string, preserving the old identity mechanism.

Document type remains part of the core Document representation. The removal of schemas/models from the MVP does **not** remove Document type.

#### RevisionStore

This is the renamed semantic role of the old top-level `recordStore`.

A Revision is a historical event, not a structurally deduplicated content value.

A Revision connects:

- its random revision identity;
- Document reference;
- metadata Record reference;
- data Record reference;
- document archive state.

The Revision is the final logical entry of every transaction.

---

## 6. IDs and counters

### 6.1 Documents

Document IDs are random opaque strings generated once when a Document is created:

```text
crypto.randomUUID()
```

The compact `D` reference remains a global DocumentStore counter. Resolving it
returns the Document's random ID and type.

### 6.2 Revisions

Revision IDs are independent random opaque strings generated once per Revision:

```text
crypto.randomUUID()
```

The compact `R` reference remains a global RevisionStore counter. The random
Revision ID is stored in its metadata Record.

### 6.3 Value-store references

Preserve the old counter/reference-store philosophy for
String/Tuple/Record/Document/Revision stores. Counters are store-local Numbers
with two operations: `fork()` creates a counter starting at the current value,
and `getId()` returns the current value and increments it. Do not add global
counter management, a `nextId` helper, store-level safe-integer checks, or
BigInt store counters. The compact integer codec retains its input validation;
this defines the practical upper bound for Number-backed store counters. BigInt
remains limited to internal codec arithmetic.

Reference functions immediately encode the numeric counter value into a plain
string such as `S...`, `A...`, `O...`, `D...`, or `R...`. Store Maps retain that
complete compact reference string; they do not retain a runtime reference
wrapper object.

### 6.4 Counter transactionality

Every counter that can advance during a Revision transaction is forked before
transaction discovery begins.

Committed counters are not advanced during speculative discovery.

On success, forked counters replace committed counters.

On failure, forked counters are discarded.

**Invariant:** a failed transaction consumes no counter-based store IDs. Random
Document/Revision identities may have been generated, but they remain
unpublished.

---

## 7. Canonical value -> compact reference maps

### 7.1 Use `Map`, not `WeakMap`

For canonical composite values, use ordinary `Map` keyed by canonical Record/Tuple reference.

Conceptually:

```js
const tupleReferences = new Map()
const recordReferences = new Map()
```

The database is append-only and fully resident in the MVP. Persisted values are intentionally retained, so WeakMap lifetime semantics provide no useful benefit.

Persistent stores only need the value -> compact-reference direction. Do not add
`getValue` or a reverse Map to the live generic store. Replay builds separate,
ordered ID -> value tables while reconstructing the file.

This ordinary-`Map` requirement applies to persistent value -> reference
mappings. The private `WeakMap` caches used by `Record.keys` and `Record.values`
are allowed because they cache derived Tuples and are not persistent stores.

### 7.2 Meaning of a hit

A hit means:

> This canonical value is already persisted in this database.

Therefore:

```text
Map hit
-> return existing compact reference string
-> do not inspect children
-> emit nothing
```

This is the primary runtime benefit of integrating Oddo canonical identity with odbx persistence.

### 7.3 Meaning of a miss

A miss starts recursive persistence discovery for that value.

New mappings may be inserted eagerly into the normal persistent Map so the same
new canonical value encountered later in the current transaction resolves to
the same provisional compact reference.

Every speculative insertion is reported to transaction orchestration as a
`[keys, value]` cleanup entry. Stores do not retain a transaction-local entries
collection.

On a miss, the store calls `write(definition, value, keys)`. The transaction
callback appends the definition and immediately records `[keys, value]`. Child
calls do this before control returns to a parent, so their entries remain
removable if a later parent operation throws.

---

## 8. Recursive discovery and transaction output

Preserve the central old-IDBX get-or-create behavior through the direct call:

```js
getKey(write, value)
```

> Return the existing compact reference, or recursively create every missing
> dependency and queue new definitions before returning the newly allocated
> compact reference.

`write` remains a plain function, not an object. Its exact call is
`write(definition, value, keys)`: it appends the definition and records
`[keys, value]` for transaction cleanup on failure.

The rewritten algorithm differs in lookup mechanism and transaction safety, not in traversal shape.

For a Tuple/Record miss:

1. Recursively ensure child values.
2. Allocate the provisional numeric ID from the forked counter and encode its
   compact reference string.
3. Insert canonical-value -> provisional-reference into the store Map.
4. Call `write(definition, value, keys)`; the transaction callback queues the
   definition and immediately records `[keys, value]`.
5. Return the provisional compact reference.

The queue is naturally child-before-parent.

Example:

```text
new String definitions and inline primitive values
new child Tuples
new child Records
new parent Tuple/Record
Document definition if required
revision metadata Record if new
final Revision
```

The complete definition sequence is joined into one transaction payload before
file I/O begins.

---

## 9. Write transaction lifecycle

### 9.1 Serialized write queue

At most one write transaction may be in preparation, persistence, or rollback
at a time. A successful Revision is published synchronously before the next
queued operation begins.

The queue covers operation preparation, discovery, and persistence, not merely
the filesystem write. Publication immediately follows the successful queued
commit.

A later write must never observe speculative IDs/mappings created by an earlier uncommitted write.

### 9.2 Transaction state

A transaction needs at least:

```text
forked counters
created/speculative [keys, value] cleanup entries
output definitions
queued Revision-producing operation
committed file position
```

All of this state belongs to transaction orchestration. A store's only
transaction-local state is its counter fork: start discovery with the fork, keep
it on success, and restore the previous counter on failure. On a miss, the store
passes its Map to `write` as part of `[keys, value]`; transaction orchestration
deletes that entry on failure. The store retains no rollback entries, output,
promise, or publication state.

Do not publish Document/Revision state into committed indexes during discovery.

### 9.3 Success path

After the complete transaction payload has been written successfully:

1. Advance the committed file position to the value returned after the complete write.
2. Keep the speculative value->reference Map entries; they are now committed.
3. Keep the transaction counter forks as the current store counters.
4. Publish the Revision, including its Document identity when this was a create.
5. Update the Document's revision history/latest state/archive state.
6. Resolve the entity operation promise.

### 9.4 Failure path

If the write rejects:

1. Delete every speculative value->reference Map entry recorded as a cleanup entry.
2. Restore the previous store counters, discarding the transaction forks.
3. Publish no Revision or new Document identity.
4. Leave the committed Document/revision indexes unchanged.
5. Leave the committed file position unchanged.
6. Reject the entity operation promise.

A partial physical suffix may remain after a failed write. The next queued write
starts at the unchanged committed position and overwrites it. If the process is
closed first, `DB.open()` finds the last complete Revision boundary and
truncates the suffix before returning the database.

A rejected write does not disable or poison the database instance. After
cleanup, the queue continues with later operations from the unchanged committed
position.

---

## 10. File position and one-payload rule

The writer retains the byte position immediately after the last successfully
committed transaction. That position is the starting offset for the next
transaction.

All entries for one Revision transaction are joined into one payload before I/O.
The final Revision is not written as a separate transaction. A short filesystem
write may require continuing the same payload from the returned byte count.

The writer advances its position only after the complete payload succeeds. On
failure the position remains unchanged, so the next transaction overwrites any
partial suffix at the same byte offset.

Positions are byte offsets, not JavaScript UTF-16 string lengths.

---

## 11. Replay and recovery

Preserve the old sequential-file/replay model while using explicit write
positions for live transactions.

Replay, rather than the live stores, owns the ordered ID -> value tables needed
to resolve compact references while loading. These reconstruction tables are
separate from the stores' value -> compact-reference Maps.

On open, a syntax pass records the byte offset after each complete Revision. If
EOF or malformed trailing data occurs, the last such offset is the committed
boundary. Replay then consumes only that complete prefix into fresh stores and
committed indexes. `DB.open()` truncates bytes after the boundary before it
accepts future writes.

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

Definitions establish store entries in sequence. A typed reference string encodes
the referenced entry's numeric, repository-local store ID.

### 12.3 MODIFY the parser implementation

Drop the old generic regex tokenizer algorithm that repeatedly searches every regex against the remaining string and materializes a full token array.

Replace it with a deterministic scanner/parser for the same compact grammar.

The parser must:

- dispatch from known leading syntax/token characters;
- parse sequentially;
- track byte position;
- detect malformed/incomplete trailing input; and
- yield complete syntactic entries in physical order.

Only a completed Revision entry exposes `endOffset`, because Revision boundaries
are the offsets used for recovery. Other parsed values do not retain offsets.

The parser is syntax-only. It does not resolve references, reconstruct values,
own provisional transaction state, perform I/O, or publish Documents and
Revisions. The replay layer consumes the complete prefix selected by the
Revision-boundary scan and reconstructs children before parents.

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

BigInt may be used internally by the codec as an implementation type for manipulating 64 bits; this does **not** reintroduce BigInt as an odbx data value.

### 14.4 NaN

Do not add a special NaN canonicalization layer in the MVP. Encode the runtime's normal Float64 NaN representation.

---

## 15. Revision/version model

### 15.1 Revision identity

Revision ID is a random opaque string stored in ordinary revision metadata. The
RevisionStore counter only supplies its compact repository-local `R` reference.

### 15.2 `from` MUST be preserved

`from` records the ancestor Revision from which the new Revision was created.

It is **not** redundant chronological information.

Example:

```text
R1 -> R2 -> R3 -> R4
       \
        -> R5
```

If R5 was created by taking R2 and editing from there:

```text
R5.metadata.from = R2.id
```

R5 may be chronologically newer than R4 while still descending from R2.

This lineage is a historical fact and belongs in revision metadata.
The persistence kernel stores the caller-selected `from` value without checking
that the referenced Revision exists or belongs to the same Document. Such
validation belongs to a higher layer.

### 15.3 Revision metadata

Metadata is an ordinary persisted Record containing exactly:

```js
Record({ id, timestamp, archived, from })
```

Callers do not provide an arbitrary metadata object. Revision `id` is a random
UUID and `timestamp` is generated with `Date.now()` when the queued operation
executes. A first Revision stores `from: null`. `update` receives the intended
ancestor Revision ID from its caller. Archive and restore set `from` to the
latest Revision ID when their queued operation begins.

`user` is not an MVP feature. The old code hard-coded it and never implemented a real user source.

`published` / draft state is removed from the MVP and should not be recreated in the base model.

### 15.4 Final Revision entry

Preserve the old top-level structure conceptually:

```text
Revision(
  DocumentRef,
  MetadataRecordRef,
  DataRecordRef,
  ArchivedState
)
```

Archive state also exists in metadata for convenience; do not remove that duplication simply for normalization.

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

with a random opaque string `id`.

Document type remains core data.

### 16.2 Document creation

A call to `db.createEntity(name).create(data)` creates a new Document and its
first Revision in one queued persistence transaction. The Document remains the
small internal Record `{ id, type: name }`.

The new Document must not become visible in committed in-memory state before the transaction write succeeds.

On failure, its provisional counter allocation is discarded and the Document is not published.

---

## 17. Archive semantics

### 17.1 Meaning

`archived` is **Document state**, i.e. document-level soft deletion.

It is recorded on every Revision because each Revision preserves what the
Document state became at that historical point. It is not a field injected into
the Document body. The value is stored both in Revision metadata and in the
top-level Revision entry.

### 17.2 Archive/restore behavior

Archiving or restoring creates another Revision. History is never physically deleted.

`entity.archive(documentId)` and `entity.restore(documentId)` enter the same
serialized queue as create and update. When their turn begins, they resolve the
latest committed Revision, reuse its exact data Record, set `from` to that
Revision's ID, and set the new archive state.

`entity.update(...)` resolves the current Revision inside the queue and throws
`Cannot update archived document` when that Revision is archived. The Document
must be restored before it can be updated.

### 17.3 Preserve metadata duplication

The old implementation duplicates archive information between convenient revision metadata and the top-level Revision data.

This is intentional convenience, not a normalization bug to remove in the MVP.

### 17.4 Filtering

Collection-form `db.latest` uses tri-state archive filtering:

```js
archived: false // active documents only; normal/default collection view
archived: true  // archived documents only
archived: null  // all documents regardless of archive state
```

`db.latest({ id })` returns the latest Revision for one Document and ignores an
`archived` option. Exact historical Revision access through `db.revision(id)`
and `db.revisions({ id })` remains available; archive soft deletion never erases
history.

---

## 18. Public API

The package exports `DB`, `Record`, and `Tuple`. A database is created or opened
with:

```js
const db = await DB.create(filename)
const reopened = await DB.open(filename) // open an existing database
```

Writes are exposed through a named entity handle:

```js
const posts = db.createEntity('post')

const first = await posts.create(dataRecord)
const next = await posts.update(documentId, dataRecord, { from: first.id })
const archived = await posts.archive(documentId)
const restored = await posts.restore(documentId)
```

`createEntity(name)` establishes the Document `type` used by `create`. Defining
the same entity name twice on one database instance throws. The public API does
not expose the internal `addDocumentType` or raw `save` functions.

`create(data)` requires an Oddo Record and creates a random Document identity and
its first Revision in one queued transaction. `update(id, data, { from })`
requires a Record body and accepts the caller-selected ancestor Revision ID.
Entity operations resolve to the committed Revision they created.

Reads and lifecycle remain database-level:

```js
db.latest()                    // latest active Revisions
db.latest({ archived: false }) // latest active Revisions
db.latest({ archived: true })  // latest archived Revisions
db.latest({ archived: null })  // latest Revisions regardless of archive state
db.latest({ id: documentId })  // one Document's latest Revision
db.revision(revisionId)        // one historical Revision
db.revisions({ id: documentId }) // one Document's complete history
await db.close()
```

The old general query DSL is not part of the MVP. These methods return direct
values or collections rather than recreating `iterable.js`/`query-item.js`
machinery.

---

## 19. Read/write scheduling

### Writes

All writes are serialized through one queue covering preparation, discovery,
persistence, and rollback. Successful publication immediately follows the
queued commit and occurs before the next operation begins.

A rejected transaction does not block the queue after in-memory cleanup completes.

### Reads

Reads expose only committed state.

There is no extra read queue requirement. If a caller needs read-after-write
behavior, it awaits the entity create/update/archive/restore operation before
reading.

---

# 20. Old repository component migration map

This section is the primary code-level handover.

---

## Historical `src/helpers.js` -> current `src/stores.mjs` and `src/commit.mjs`

### Status: **IMPLEMENTED; store/get-or-create pattern preserved**

### KEEP

- `createStore` / store-local encapsulation concept.
- the direct `getKey(write, value)` get-or-create operation.
- Per-store counters.
- `fork` concept for transactional counter state.
- `serializeObject` conceptual decomposition into keys and values.

### MODIFY

- Replace old serialized-string/object-property structural matching for Record/Tuple with `Map` keyed by canonical Oddo Record/Tuple reference.
- Use normal Map-based backing stores where appropriate instead of `Object.create` lookup tables.
- Forked counters must begin from the committed counter value, not reset to zero.
- Transaction discovery may eagerly add speculative canonical-value->reference
  mappings, but transaction orchestration owns the `[keys, value]` cleanup
  entries. Do not add store-local pending entries.
- On a miss, the store passes `definition`, `value`, and `keys` to `write`;
  transaction orchestration immediately records `[keys, value]` and queues the
  definition.
- Generate random Document and Revision IDs before serialization, outside the generic store.
- Record key/value decomposition uses cached `Record.keys` and `Record.values`
  canonical Tuples.

### REMOVE

- The unbounded global collision-tracking Set used by the old ID generator.
- Prototype-chain store inheritance as a substitute for correct transaction rollback.

### Critical warning

The old `fork()` implementation inherits maps but starts `counter = 0n`; do not copy that behavior.
Store counters are Numbers, and a fork begins at the current counter value.

---

## Historical `src/stores.js` -> current `src/stores.mjs` and `src/replay.mjs`

### Status: **IMPLEMENTED around Oddo and transactions**

### KEEP

- Separate String / collection / object / Document / top-level Revision store architecture.
- String interning.
- Tuple child-first serialization.
- Record decomposition into keys Tuple + values Tuple.
- Document `{ id, type }` concept.
- Final top-level Revision containing Document, metadata, Record body, and archive state.
- Generic `matchType`/type-dispatch concept.
- Replay-layer reconstruction of stores from token definitions/references.

### MODIFY

- `arrayStore` becomes TupleStore semantically.
- `objectStore` becomes RecordStore semantically.
- Tuple/Record persistent lookup uses canonical object reference Maps.
- Records use Oddo's unordered canonical key order.
- `documentStore` keeps random Document IDs and uses a global compact `D` reference counter.
- `recordStore` becomes RevisionStore; random Revision IDs live in metadata while `R` remains compact and repository-local.
- Revision data accepts an Oddo Record root only; Tuples remain valid as nested values.
- BigInt value handling is removed.
- Oddo values contain no `undefined`; JavaScript wrappers normalize host `undefined` to null before native construction.
- `-0` normalization occurs in number encoding.
- Remove all schema/model/relations hooks from persistence (`initModels`, `selectModel`, `validate`, `createRecord`, `releaseModel`, etc.).
- Do not mutate committed Document/revision indexes while serializing. Stage those effects until write success.

### REMOVE from MVP

- `initModels` dependency.
- `$or` dependency.
- schema validation from save path.
- relation/model lifecycle calls.
- publication/draft state.

---

## `src/db.mjs`

### Status: **IMPLEMENTED**

- Exposes `DB.create` and `DB.open`.
- Exposes `createEntity`, committed Revision reads, and `close` on each database.
- Keeps raw Revision construction and save orchestration private.
- Serializes each entity operation through the writer queue.
- Publishes a Revision and its Document history only after its payload succeeds.
- Delays update/archive/restore state lookup until the operation reaches the queue.
- Rejects updates to archived Documents.
- Replays the append-only history through complete Revision boundaries.
- Closes the file handle and propagates the error if open/replay/recovery fails.

### REMOVE from MVP

- `runQuery` integration.
- schema export.
- middleware/RPC export.
- hard-coded `user` metadata.
- `publish` parameter and published/draft state.

---

## Historical `src/utils.js` -> current `src/codec.mjs`

### Status: **IMPLEMENTED; codec core retained and unrelated utilities removed**

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
- random identity generation from codec utilities; it belongs in Document/Revision assembly.

---

## Historical `src/symbols.js` -> current `src/symbols.mjs`

### Status: **IMPLEMENTED; typed-reference abstraction retained**

### KEEP

- Type-specific functions returning compact reference strings.
- `N`, `S`, `A`, `O`, `D`, `R` token/reference distinction.
- conversion from numeric store counters to encoded compact reference strings.

### MODIFY

- underlying `encodeInt` uses the safe 63,232 radix mapping.
- Number encoding uses revised Float64 codec.
- Tuple/Record reference functions keep the `A`/`O` persistent letters while
  runtime code refers to TupleStore/RecordStore.
- BigInt/Integer value-token support is removed from the persistent value domain.

### DO NOT

Do not rename persistent token letters merely to make them spell Tuple/Record unless there is a demonstrated need.

---

## Historical `src/parser/tokenizer.js` -> current `src/parser.mjs`

### Status: **IMPLEMENTED; parser replaced and grammar retained**

### KEEP

- token/definition grammar.
- delimiter meanings.
- typed references.
- final Revision entry grammar role.

### REMOVE

- generic regex-search tokenizer algorithm.
- full token-array materialization as a prerequisite to replay.

### REPLACE WITH

A deterministic sequential parser/scanner that parses the existing compact
language directly and yields syntactic entries. Only completed Revision entries
expose their ending byte offset. Reference resolution and publication belong to
replay, not to the parser.

---

## Historical `src/getters.js` -> current `src/db.mjs`

### Status: **IMPLEMENTED INLINE**

### KEEP

- per-Document revision history.
- latest Revision pointer/state.
- current Document archive state.
- lookup by Document ID and Revision ID.
- basic `latest`, `revision`, `revisions` concepts.

### IMPLEMENTED FORM

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

## Historical `src/adapters/ascii.js` -> current `src/persist.mjs`

### Status: **IMPLEMENTED WITHOUT AN ADAPTER HIERARCHY**

- Files are opened directly in `src/db.mjs`.
- `src/persist.mjs` writes an already-built transaction payload at the supplied
  byte position and continues short writes until the payload is complete.
- The writer advances its committed position only after complete success.
- `DB.open()` truncates an incomplete suffix after replay identifies the last
  complete Revision boundary.

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

### Status: **IMPLEMENTED**

- ESM remains appropriate.
- Node's built-in filesystem modules are used without an `fs` npm placeholder dependency.
- The test command is `node --test`.
- Parcel/browser build dependencies are absent from the core MVP.

---

# 21. Implemented MVP source layout

```text
src/
  codec.mjs          // safe compact integers + Float64 encoding
  commit.mjs         // definition collection and failure cleanup
  db.mjs             // public database/entity API and committed read indexes
  index.mjs          // package exports
  init.mjs           // internal store initialization export
  parser.mjs         // deterministic syntax-only compact-stream parser
  persist.mjs        // positioned filesystem writes
  queue.mjs          // serialized operation queue
  replay.mjs         // reference resolution and Revision-boundary recovery
  stores.mjs         // String/Tuple/Record/Document/Revision stores
  symbols.mjs        // compact reference-string functions
  values.mjs         // local Oddo runtime copy + cached Record decomposition helpers
  writer.mjs         // queued Revision discovery and persistence
```

Committed history/read indexes remain inside `db.mjs`; no separate getters
module or adapter hierarchy is needed.

Tests:

```text
test/
  codec.test.mjs
  db.test.mjs
  parser.test.mjs
  persistence.test.mjs
  recovery.test.mjs
  values.test.mjs
```

These test modules are present. Add or change tests only with explicit user
permission. Any approved new tests must be unit tests.

---

# 22. Implementation sequence

## Phase 1 — Parser and codec — implemented

Implemented:

- deterministic sequential syntax parser whose completed Revision entries expose their ending byte offset;
- malformed and incomplete suffix detection;
- safe high-radix integer mapping with surrogate hole;
- encode/decode counter round trips;
- Float64 encode/decode using explicit endian;
- `-0 -> 0` persistence normalization;
- strings and primitive tokens.

The parser does not perform replay or I/O. Do not change the compact grammar
architecture.

## Phase 2 — Oddo runtime integration — implemented

Implemented:

- canonical Oddo Record and Tuple construction;
- unchanged canonical identity semantics;
- cached `Record.keys` and `Record.values` persistence helpers in odbx; and
- no persistent `undefined` or BigInt value type.

## Phase 3 — Stores and persistent value discovery — implemented

Implemented:

- StringStore;
- TupleStore;
- RecordStore;
- DocumentStore;
- RevisionStore;
- canonical-reference Map lookup;
- child-first recursive discovery;
- cached Record keys/value Tuple decomposition;
- Number counters and counter forks;
- random Document IDs + type;
- random Revision IDs in metadata;
- metadata Record persistence;
- internally generated Revision IDs and timestamps;
- `from: null` on the first Revision;
- caller-selected ancestry on update;
- archive state in Revisions.

## Phase 4 — Minimal transaction discovery and rollback — implemented

Implemented:

- a transaction-owned output array;
- transaction-owned `[keys, value]` cleanup entries;
- immediate recording of `[keys, value]` from every store miss;
- the plain `write(definition, value, keys)` callback;
- counter forks before discovery;
- final Revision discovery;
- keeping forked counters and Map entries on success; and
- deleting speculative Map entries and restoring counters on failure.

Stores retain no cleanup entries. `write` remains a plain function, not an object.

## Phase 5 — Durable serialized write — implemented

Implemented:

- serialized write queue;
- one payload per transaction;
- awaited positioned writes, including short-write continuation;
- a committed byte position that advances only after complete success;
- retry overwrite from the unchanged position after failure; and
- publication only after persistence succeeds.

## Phase 6 — Replay and recovery — implemented

Implemented a syntax pass that finds the last complete Revision boundary,
followed by child-first reference resolution of that committed prefix. Open
truncates an incomplete suffix and starts the writer at the recovered byte
position.

## Phase 7 — Minimal committed indexes and public API — implemented

Implemented:

- committed Revision indexes/history published only after persistence succeeds;
- `DB.create` and `DB.open`;
- `db.createEntity(name)`;
- entity `create`, `update`, `archive`, and `restore`;
- database-level `latest`, `revision`, and `revisions`; and
- automatic internal Revision metadata.

Do not implement the old query DSL.

---

# 23. Correctness cases

These are MVP acceptance requirements. Further test creation or modification
still requires explicit user permission, and approved new tests must be unit
tests.

## 23.1 Canonical persistence

- same canonical Tuple saved twice -> one Tuple definition;
- same canonical Record saved twice -> one Record definition;
- repeated child shared across unrelated documents -> one persistent child;
- persisted child Map hit prevents descendant traversal;
- same new child encountered multiple times in one transaction gets one provisional compact reference.

## 23.2 Counter rollback

Inject write failure after complete discovery.

Verify:

- committed counters unchanged;
- speculative Map entries removed;
- failed DocumentStore counter ID and its compact reference are reusable;
- failed RevisionStore counter ID and its compact reference are reusable;
- failed random identities remain unpublished;
- retry emits compact references matching replayed store IDs.

## 23.3 Retained failed values

Caller retains the canonical Record/Tuple used by a failed transaction.

Verify retry does **not** hit an incorrect stale compact reference. This proves rollback does not depend on GC/WeakMap behavior.

## 23.4 Partial write

Inject failure after writing arbitrary byte prefixes of a complete transaction payload.

Verify:

- the entity operation rejects;
- memory rolls back;
- the committed file position remains unchanged;
- the next transaction overwrites the partial suffix and succeeds with correct compact references;
- reopening before a retry truncates the suffix to the last complete Revision.

## 23.5 Replay boundaries

Truncate a valid file at many positions between one Revision and the next.

Verify only complete Revisions become committed after reopen.

## 23.6 Revision ancestry

Create R1 -> R2 -> R3, then create R4 from R1.

Verify:

- R4 is chronologically latest;
- `R4.metadata.from === R1.id`;
- R2/R3 remain in history;
- ancestry is not inferred merely from chronological order.

## 23.7 Archive

- archive creates a new Revision;
- archive-only revision reuses the latest data Record;
- archive and restore derive `from` and data when their queued operation begins;
- current Document archived state updates only after successful write;
- failed archive leaves current state unchanged;
- restore creates a later Revision;
- update rejects while the latest Revision is archived;
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
- multi-digit counter IDs across radix boundaries.

---

# 24. Explicit implementation prohibitions

The implementation agent must not:

- replace the compact format with JSON or JSONL;
- add checksums/frame lengths/file headers without a newly approved requirement;
- add SQLite/LevelDB/another database engine;
- introduce content-derived addresses for value stores;
- remove DocumentStore;
- remove Document `type`;
- remove RevisionStore;
- drop `from` ancestry;
- normalize away archive duplication that exists for convenience;
- reintroduce published/draft state;
- reintroduce BigInt as a stored value type;
- add an `undefined` persistent token; Oddo never produces it, and JavaScript wrappers normalize host undefined before native construction;
- add schemas/models/relations/RPC/mutator/plain-JS wrapper to MVP;
- use WeakMap for the persistent canonical composite -> reference store;
- add reverse `getValue` lookup to the live generic stores; replay may maintain
  temporary ID-to-value tables while rebuilding state;
- retain rollback entries, output, promises, or publication state inside a store;
- turn `write` into an object, pass a transaction object to it, or deviate from
  the exact `write(definition, value, keys)` callback contract;
- represent live compact references as wrapper objects rather than strings;
- add or change tests without explicit user permission, or add non-unit tests;
- advance committed counters before write success;
- publish Documents/Revisions before write success;
- let an unawaited filesystem write escape from an entity operation;
- advance the committed file position after a failed write;
- return a database instance after open/replay/recovery fails.

---

# 25. Architectural invariants

The implementation is correct only if all of these remain true.

1. Oddo canonical identity defines live Record/Tuple equality.
2. One committed canonical Record/Tuple has one compact reference string per store/database instance.
3. A committed persistent Map hit ends traversal of that subtree.
4. New definitions are emitted child-before-parent.
5. Revisions are the final logical transaction entries.
6. Document and Revision IDs are random opaque identities; `D` and `R` remain compact repository-local counter references.
7. Document `type` remains persisted.
8. Every Document body is an Oddo Record; Tuples may occur inside it.
9. Revision metadata is generated internally as `{ id, timestamp, archived, from }`, with `from: null` on creation.
10. `from` records actual ancestor Revision, not merely chronological predecessor.
11. Archive is Document state preserved historically through Revisions.
12. Updating an archived Document is rejected until it is restored.
13. A failed transaction consumes no counter-based store IDs; generated random identities remain unpublished.
14. A failed transaction leaves no speculative Map mappings.
15. A failed transaction publishes no Document/Revision state.
16. A failed partial write leaves the committed position unchanged, and the next write overwrites from that position.
17. Replay accepts no transaction lacking a complete final Revision.
18. At most one write transaction is active at a time.
19. Reads expose committed state only.
20. The old compact grammar architecture remains the persistent format.
21. The parser yields syntax, with `endOffset` only on completed Revisions; replay resolves and publishes state.
22. Stores retain only counter forks as transaction-local state; transaction orchestration owns `[keys, value]` cleanup entries and output.
23. Live compact references are strings, not wrapper objects.

---

# 26. Historical source guide

These old files remain historical references for the current modules:

- `src/helpers.js` -> `src/stores.mjs` and `src/commit.mjs` for store/get-or-create and counter-fork mechanisms.
- `src/stores.js` -> `src/stores.mjs` and `src/replay.mjs` for child-first definitions and value reconstruction.
- `src/db.mjs` -> current `src/db.mjs`, `src/writer.mjs`, `src/queue.mjs`, `src/commit.mjs`, `src/persist.mjs`, and `src/replay.mjs` for file lifecycle, transactions, and replay.
- `src/utils.js` -> `src/codec.mjs` for compact integers and Float64 encoding.
- `src/symbols.js` -> `src/symbols.mjs` for compact typed references.
- `src/parser/tokenizer.js` -> `src/parser.mjs` for the grammar, with the old tokenizer algorithm replaced.
- `src/getters.js` -> current `src/db.mjs` for committed Revision/history/archive reads.
- `src/schema.js`, `src/models.js`, `src/relations.js` — deferred-layer prior art only; do not port to MVP.
- `src/query.js`, `src/iterable.js`, `src/query-item.js` — old query DSL; do not port to MVP.
- `src/adapters/ascii.js` -> `src/persist.mjs` and `src/db.mjs` for positioned writes and open-time suffix truncation.

---

# 27. Final implementation summary

The rewrite is **not a new database design**.

It is a disciplined rewrite of the strongest original IDBX persistence ideas around the new Oddo canonical value runtime:

```text
Oddo canonical Record/Tuple
        |
        v
persistent Map lookup
  hit --------> reuse compact reference, stop
  miss
        |
        v
recursive child-first discovery
        |
        v
provisional references from forked counters
        |
        v
speculative Map entries + transaction-owned cleanup entries
        |
        v
compact old-IDBX-style definitions
        |
        v
Document / internal metadata / Record data
        |
        v
final Revision
        |
        v
one payload written at the committed position
     /       \
 success     failure
   |           |
keep maps    delete speculative maps
keep forks   restore previous counters
advance      publish nothing
position     keep file position
publish      reject
Revision
```

Everything above this kernel—plain-JS conversion, proxy mutation, RPC, schemas, relations, models, publication—is deliberately deferred.

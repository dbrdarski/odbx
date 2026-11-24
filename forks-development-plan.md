# ODBX fork development plan

## Purpose and scope

A fork continues a database from its committed state at the instant the fork is created. The parent and child can then receive independent revisions. Fork files remain on disk after close and are loaded only by an explicit fork path. Moving selected entries back to an ancestor, merging, deleting forks, and automatic loading of fork states are outside this feature.

## Public API

```js
const root = await DB.open("knowledge.odbx", definitions);
const numbered = await root.fork();                // knowledge.0.odbx
const named = await root.fork("asdfgh123456");    // knowledge.asdfgh123456.odbx
const nested = await named.fork();                 // knowledge.asdfgh123456.0.odbx

await DB.open("knowledge.odbx", definitions);     // root only
await DB.open("knowledge.odbx", definitions, ["asdfgh123456", 0, 1]);
await root.openFork("asdfgh123456", 0, 1);         // path relative to root
await named.openFork(0, 1);                       // path relative to named
```

The third argument to `DB.open` is an optional array of string and numeric fork identifiers. `db.openFork(...identifiers)` resolves a path relative to that handle. `db.fork(name?)` creates a direct child of that handle. All three opening or forking calls return promises. There is no static `DB.fork`.

The first argument to `DB.open` names the root file. A fork file alone lacks its inherited state and is opened through the root plus a fork path, or through an open ancestor's `openFork` method.

## File names and fork entries

Each parent file records its direct children with top-level fork entries:

```text
@             next numbered child
@pero         child named "pero"
```

Bare `@` entries are numbered from zero in their physical parent file. Named entries do not advance that count: `@ @ @pero @` identifies children `0`, `1`, `"pero"`, and `2`. No numeric index, quotes, or terminator is written in the entry.

Names must match `/^[a-z_][a-z0-9_]*$/`. This permits lowercase letters, digits after the first character, and underscores. It excludes path separators, dots, uppercase letters, and names that would collide with numeric filenames. A name must be unused among that parent's direct children. File creation must not overwrite an existing path.

A child filename inserts its identifier before `.odbx`. Each additional fork adds another component, for example `knowledge.asdfgh123456.0.1.odbx`.

## Parser and replay boundary

Add an `@` branch to `src/parser.mjs`. Immediately after `@`, a lowercase letter or underscore starts a name. Consume its following lowercase letters, digits, and underscores, stopping before the next byte outside that alphabet; leave that byte for the next top-level entry. With no name, the token represents a numbered fork. The parser emits a fork token with its name or numbered status and an ending byte offset.

The existing `src/replay.mjs` boundary pass remembers the ending byte offset of the last complete Revision. Extend it to remember the offset of the last complete Revision **or fork entry**. This preserves a parent file whose final entry is `@` or `@name` when `DB.open` runs. The offset is used for the existing physical recovery and writer position; fork lookup does not store or search byte positions.

Fork tokens do not enter any String, Tuple, Record, Document, or Revision store and consume no store IDs. Replaying a file uses them to rebuild that file's lightweight direct-child registry.

## Fork creation and state ownership

Fork creation takes a turn in the parent's serialized operation queue. Every earlier accepted write must have persisted **and published** before the fork's turn; later parent writes wait until the fork is created. In that turn, select the child identifier, create its empty file exclusively, append its fork entry through the parent's positioned writer, copy committed in-memory state, and return an open child handle. The parent's writer position advances past the completed fork entry, so later parent revisions follow it.

The copy includes the five stores' counters and value-to-reference maps, each entity's document histories and revision lookup, and relationship snapshots. Mutable maps and history arrays must be independent; entity and relationship methods must bind to the child's copied state. Pending queue jobs and the transaction-local definition array are not copied. The child has its own writer, queue, and file, initially at byte zero. An open child remains usable independently of whether its parent handle is later closed.

If writing the parent fork entry fails after the empty child file is created, close and remove that unregistered file and leave the parent registry unchanged. Successfully created fork files are retained.

In the current code, `save()` publishes via `write(operation).then(publish)`, outside the queued commit. Include publication in the serialized operation before a later fork can copy state. The fork entry uses the same positioned persistence path as other writes, including its handling of short writes and unchanged committed position on failure.

## Opening a fork path

For each requested path component, parse the current physical file token by token. A number selects the corresponding zero-based bare `@`; a string selects an exact `@name` match. Stop replay of that parent at the matching entry, move to the selected child file, and continue with the next component. In the final file, replay its committed contents. Later entries in ancestors are excluded from the opened fork state.

Reference resolution must continue across the selected file chain. `stores.matchTokens()` currently initializes fresh ID-to-value tables on each call, so opening a fork needs one replay context spanning the selected ancestor tokens and the final file. Keep direct-child registries separate for each physical file. Only the requested chain is loaded; sibling fork database states are not loaded. The selected file's writer starts at its own recovered file length, not at the length of the full ancestry.

An unknown fork identifier or missing child file makes the open call reject. An ordinary two-argument `DB.open` loads the root's state and direct-child registry without loading child files.

## Close and information

All handles share the agreed close contract: operations accepted before `close()` finish, then the file closes; operations submitted after closing begins are rejected. Revision writes, fork creation, and close must therefore use the same per-handle ordering. `close()` retains the file, and closing one handle does not close other already-open handles.

A database handle maintains a lightweight registry of its direct child identifiers and filenames. It does not retain loaded child database states in that registry. `db.info()` is proposed as a synchronous snapshot of `filename`, absolute file `path`, `rootPath`, `forkPath`, and direct child identifiers. The precise additional fields can be decided when the method is implemented.

## Implementation sequence and verification

1. Extend `src/parser.mjs` and `src/replay.mjs` for fork tokens and fork boundaries.
2. Make the reference decoder reusable across consecutive physical files in `src/stores.mjs` and `src/replay.mjs`; add copying of store and entity state for live fork creation.
3. Extend the per-handle operation queue in `src/commit.mjs`, `src/writer.mjs`, and `src/db.mjs` so persistence, publication, fork creation, and close follow one order.
4. Add `db.fork`, relative `db.openFork`, the optional `DB.open` fork path, filenames, direct-child registry, and `db.info` in `src/db.mjs`.
5. Verify named and numbered indexing (including `@ @ @pero @`), nested mixed paths, inherited revisions and relationships, parent/child isolation after later writes, explicit reopen, retained files, and write/fork/close ordering. Existing two-argument `DB.open` behavior must remain intact.

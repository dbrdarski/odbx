# Value stores and writes

`createStore({ reference, serialize })` specializes the common store mechanism and
returns a factory. String, Tuple and Record stores use that same factory.
Each instance owns a canonical-value-to-reference Map and a counter with
`fork()` and `getId()`. A hit returns immediately. On a miss, serialization
discovers children first, then the store allocates an ID, journals the mapping
and adds its definition to the transaction output.

Tuple serialization uses `Array.from` to produce an ordinary Array. Record
serialization uses canonical `Tuple(...Object.keys(value))` and
`Tuple(...Object.values(value))` with corresponding enumeration order. Inputs
are canonical values from the unchanged Oddo runtime.

## Source entry points

`init()` in `src/init.mjs` constructs the three stable value stores.
`createWrite()` in `src/write.mjs` creates their serialized write function.
The file adapter in `src/adapters/file.mjs` implements append and truncation.

```js
import { Record, Tuple } from 'odbx';
import { init } from './src/init.mjs';
import { createWrite } from './src/write.mjs';
import { fileAdapter } from './src/adapters/file.mjs';

const stores = init();
const write = createWrite(stores, fileAdapter('/tmp/fresh-values.odbx'));
const key = await write(Record({ tags: Tuple('Oddo') }));
```

Use a fresh file for this value-store example. Document/Revision assembly and
reopening through transactional replay are still pending; this is an internal
value-writing entry point, not the completed document `save` API.

The source write function owns the whole lifetime:

1. Wait for the preceding write to finish.
2. Fork the store counters and start an output array and insertion journal.
3. Call `getKey(transaction, value)` to discover the value and its dependencies.
4. Encode the collected definitions into one UTF-8 Buffer and await one append.
5. Adopt the counter forks, advance the committed byte offset and resolve with
   the reference.

If discovery or encoding fails, it rolls back the mappings and rejects. If an
append fails, it also awaits truncation to the previous committed byte offset
before rejecting or allowing the next write to start. Failed truncation blocks
queued and future writes. Stores, lookup functions and value Maps stay in place.
Create one writer per store set and file; the writer owns that set's queue.

`createWrite(stores, adapter, discover = getKey, committedEndOffset = 0)` accepts
a synchronous discovery function for a specialized store and an initial byte
offset for restored state. The adapter supplies `write(Buffer)` and
`truncate(byteOffset)`, both completing asynchronously. The default discovery
function dispatches native values to the String, Tuple and Record stores.
The transaction object passed to serializers contains those stores, their
counter forks, output and the insertion journal.

A store factory accepts `(counter = 0n, keys = new Map())` for restored counters
and canonical-value mappings. Future replay will own temporary ID-to-value
lookup tables and accept definitions only at complete Revision boundaries.

## Verification

Store tests call `init`, `createWrite` and the actual file adapter. They assert
emitted bytes, parsed definitions, reference reuse and counters. Write tests
inject failures into the adapter to verify queue ordering, rollback, byte-offset
truncation, retained-value retries and blocking after failed recovery. Tests do
not implement publication, payload encoding or a substitute replay reader.

The factory and serializer composition follow historical IDBX
[`helpers.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/helpers.js)
and [`stores.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/stores.js),
with the handover's canonical Map lookup, counter forks and rollback changes.

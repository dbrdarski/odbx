# Value stores

`createStore({ reference, serialize })` specializes the common store mechanism and
returns a factory. For example, the String store is defined by:

```js
const createStringStore = createStore({
  reference: stringReference,
  serialize: (_write, value) => encodeString(value),
});
```

The Tuple and Record factories supply their own serializers in the same way.
Each instance retains one Map from canonical value to typed persistent reference,
and its own bigint counter. A Map hit returns the reference immediately. On a
miss, serialization discovers children first, then the store allocates its ID,
journals the new mapping and appends its definition to the shared output.

Tuple serialization uses `Array.from` to produce an ordinary temporary Array.
Record serialization uses canonical `Tuple(...Object.keys(value))` and
`Tuple(...Object.values(value))`, preserving their corresponding enumeration order.
All consumers use the unchanged Oddo runtime.

## Preparing a write

The caller owns the write's lifetime and supplies plain state:

```js
import { Record, Tuple } from 'odbx';
import { createStringStore, createTupleStore, createRecordStore, getKey, rollback } from '../src/stores.mjs';

let stores = {
  stringStore: createStringStore(),
  tupleStore: createTupleStore(),
  recordStore: createRecordStore(),
};

const write = {
  stringStore: stores.stringStore.fork(),
  tupleStore: stores.tupleStore.fork(),
  recordStore: stores.recordStore.fork(),
  output: [],
  created: [],
};

try {
  const root = getKey(write, Record({ tags: Tuple('Oddo') }));
  const bytes = Buffer.from(write.output.join(''), 'utf8');
  // This slice simulates success in memory. The eventual save path first adds
  // Document/Revision entries and awaits the complete append before adopting:
  stores = {
    stringStore: write.stringStore,
    tupleStore: write.tupleStore,
    recordStore: write.recordStore,
  };
} catch (error) {
  rollback(write.created);
  throw error; // Discard this write, including its forks and output.
}
```

`fork()` shares the Map and starts a fresh counter from the source counter. On
success the caller adopts the forks; on failure it removes journaled mappings and
discards the forks. Committed counters never advance during discovery. Store
methods are internal preparation operations, not public reads: the later database
save queue must serialize the entire prepare/append/publish-or-rollback lifetime.
Discovery errors propagate to that caller, which owns rollback.

ID-to-value lookup for String/Tuple/Record belongs to temporary replay tables.
After complete replay those tables can be released. A factory accepts
`(counter = 0n, keys = new Map())` to resume the restored next counter and
value-to-reference Map. Document/Revision indexes will retain their resolved
canonical values for reads.

## Scope and verification

This slice implements value discovery, store counter forks and mapping rollback.
It performs no file I/O. Document/Revision stores, write scheduling and file
recovery remain later slices. `test/stores.test.mjs` independently resolves
emitted definitions to verify child-first ordering and canonical reconstruction;
that helper is not production replay.

The factory and serializer composition follow historical IDBX
[`helpers.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/helpers.js)
and [`stores.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/stores.js),
with the handover's canonical Map lookup, counter forks and rollback changes.

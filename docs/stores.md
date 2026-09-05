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
and its own counter with two functions: `fork()` and `getId()`. The bigint state
is private. A Map hit returns the reference immediately. On a miss, serialization
discovers children first, then the store calls the counter fork's `getId()`,
journals the new mapping and appends its definition to the shared output.

Tuple serialization uses `Array.from` to produce an ordinary temporary Array.
Record serialization uses canonical `Tuple(...Object.keys(value))` and
`Tuple(...Object.values(value))`, preserving their corresponding enumeration order.
Discovery consumes the acyclic canonical values provided by the unchanged Oddo
runtime.

## Preparing a write

The caller owns the write's lifetime and supplies plain state:

```js
import { Record, Tuple } from 'odbx';
import { createStringStore, createTupleStore, createRecordStore, getKey, rollback } from '../src/stores.mjs';

const stores = {
  stringStore: createStringStore(),
  tupleStore: createTupleStore(),
  recordStore: createRecordStore(),
};

const write = {
  ...stores,
  counters: new Map(Object.values(stores).map(store => [store, store.counter.fork()])),
  output: [],
  created: [],
};

try {
  const root = getKey(write, Record({ tags: Tuple('Oddo') }));
  const bytes = Buffer.from(write.output.join(''), 'utf8');
  // This slice simulates success in memory. The eventual save path first adds
  // Document/Revision entries and awaits the complete append before publishing:
  for (const [store, counter] of write.counters) store.counter = counter;
} catch (error) {
  rollback(write.created);
  throw error; // Discard this write, including its counter forks and output.
}
```

Each `store.counter.fork()` creates a new counter initialized from that counter's
current value. `getId()` returns the current ID and increments the counter
internally. All counters are forked before discovery. The write's `counters`
Map associates each stable store instance with its counter fork. On success the
caller replaces the committed counters with these forks; on failure it removes
journaled mappings and discards the forks. Store instances, lookup functions and
value Maps stay in place. Committed counters never advance during discovery. Store
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

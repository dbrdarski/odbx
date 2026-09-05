# Value stores

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

## Initialization

`init()` in `src/init.mjs` constructs the three stable value stores.

```js
import { init } from './src/init.mjs';

const stores = init();
```

Write orchestration, payload encoding, counter publication, file persistence and
recovery are not implemented. The store methods still expect the caller to supply
the stores, counter forks, output and insertion journal. `init()` only constructs
the stores; it does not supply a write lifecycle.

A store factory accepts `(counter = 0n, keys = new Map())` for restored counters
and canonical-value mappings. Future replay will own temporary ID-to-value
lookup tables and accept definitions only at complete Revision boundaries.

The factory and serializer composition follow historical IDBX
[`helpers.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/helpers.js)
and [`stores.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/stores.js),
with the handover's canonical Map lookup, counter forks and rollback changes.

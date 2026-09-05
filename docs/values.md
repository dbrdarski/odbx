# Local Oddo Record/Tuple runtime

`src/values.mjs` is an unchanged, byte-for-byte copy of
[`src/intern.mjs`](https://github.com/dbrdarski/oddo-next/blob/87b93602081bdb41a297dafba313c6550f581ba8/src/intern.mjs)
from Oddo exploratory commit `87b93602081bdb41a297dafba313c6550f581ba8`.
There are no local adaptations to the Oddo implementation.

The source SHA-256 is
`74f25dd7cd091e938c01d6fbbc19fcffe6831304ac9521d771aa016192e8ee53`.
An integrity test checks this alongside the behavior tests.
The file's Git attribute preserves LF line endings so checkout cannot alter it.

## Shared constructors

`src/index.mjs` re-exports `Record` and `Tuple`. Package callers and future stores
use the same module and canonical runtime:

```js
import { Record, Tuple } from 'odbx';

const child = Tuple('shared', null);
const first = Record({ a: 1, child });
const second = Record({ child: Tuple('shared', null), a: 1 });

first === second; // true
first.child === child; // true
first instanceof Record; // true
child instanceof Tuple; // true
```

Records use sorted own enumerable string-key/value entries for canonical identity.
Tuples use ordered elements. Children are constructed first and retained by
reference; construction is shallow. Empty fields/elements remain distinct from
explicit null values. The original Array/Object prototypes and interner are kept.

For Record decomposition, `Object.keys(record)` and `Object.values(record)` give
corresponding deterministic sequences. JavaScript enumerates index-like keys in
numeric order before other keys; this is unchanged source behavior.

## Language and JavaScript boundary

Oddo is a separate language and never produces `undefined`. Its native runtime
does not perform host-JavaScript normalization. Handling host `undefined` belongs
in the JavaScript-facing wrappers, which are deferred beyond this MVP slice.
No wrapper, normalization, freezing, or additional admission checks were added.

Callers must treat canonical values as immutable and construct new values for
edits, as required by Oddo's existing mutation boundary. The original interner
uses Map/WeakMap branches and WeakRef leaves for live structural identity. Future
persistent value-to-ID stores use separate strong Maps, as the handover requires.

## Verification

`test/values.test.mjs` verifies source integrity, shared exports, nominal types,
Record key-order independence, Tuple order and length, numeric singleton Tuples,
special property names, null versus absence, primitive distinctions, NaN and
signed-zero Map semantics, caller-input preservation, nested identity reuse,
construction of changed ancestors, and retained identity across event-loop turns.

The parser and codec remain the preceding slice. Persistence stores and database
operations are still pending.

# odbx

Append-only versioned content storage for Oddo canonical Records and Tuples.
The **O** stands for **Oddo**. The implementation specification is
[the MVP handover](odbx-mvp-development-handover.md).

The implemented batches contain the compact codec, sequential parser, and local
Oddo Record/Tuple runtime. Stores, the database API and file recovery are subsequent
batches.

Run the tests with Node.js 22 or later:

```sh
npm test
```

Import the shared constructors from odbx:

```js
import { Record, Tuple } from 'odbx';

const content = Record({ title: 'Oddo', tags: Tuple('database', null) });
content === Record({ tags: Tuple('database', null), title: 'Oddo' }); // true
content instanceof Record; // true
content.tags instanceof Tuple; // true

// Construct a changed value while retaining the original and its shared child.
const updated = Record({ ...content, title: 'odbx' });
updated.tags === content.tags; // true
```

Construct child Records/Tuples before their parents. These are the unchanged shallow
Oddo constructors. Oddo never produces `undefined`; handling host JavaScript
`undefined` belongs in the later JavaScript wrappers. Callers must treat returned
canonical values as immutable; the source runtime relies on that boundary and does
not prevent direct JavaScript writes. See [runtime details](docs/values.md) for the
source revision and the separation between Oddo values and JavaScript integration.

The parser accepts a UTF-8 `Buffer`, `Uint8Array`, or well-formed JavaScript string:

```js
import { parse } from './src/parser.mjs';

for (const entry of parse(Buffer.from('"Oddo"[TFV]'))) {
  console.log(entry);
}
// { type: 'string', value: 'Oddo', startOffset: 0, endOffset: 6 }
// { type: 'tuple', values: [true, false, null], startOffset: 6, endOffset: 11 }
```

Each entry is parsed on demand. No complete token array is built. A malformed or
incomplete entry raises `ParseError`; preceding entries have already been yielded.
All returned entries remain provisional until the future replay layer accepts a
Revision and publishes the corresponding stores and indexes.

See [the grammar and parser contract](docs/parser.md) and
[implementation coverage](docs/implementation-status.md).

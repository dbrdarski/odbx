# odbx

Append-only versioned content storage for Oddo canonical Records and Tuples.
The **O** stands for **Oddo**. The implementation specification is
[the MVP handover](odbx-mvp-development-handover.md).

The first implementation batch contains the compact codec and sequential parser.
The value runtime, stores, database API and file recovery are subsequent batches.

Run the tests with Node.js 22 or later:

```sh
npm test
```

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

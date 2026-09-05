# Compact grammar and parser contract

## Source

This batch follows handover §§12–14 and 26. The historical source was inspected at
IDBX commit [`fe7e6346fafd59051d1c79f4c7760cf3032af57e`](https://github.com/dbrdarski/idbx/tree/fe7e6346fafd59051d1c79f4c7760cf3032af57e):

- [`src/parser/tokenizer.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/parser/tokenizer.js): delimiters, reference letters, field order, primitive tokens.
- [`src/stores.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/stores.js): string escaping and serialized store definitions.
- [`src/utils.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/utils.js): integer digit order and Float64 word arrangement.
- [`src/symbols.js`](https://github.com/dbrdarski/idbx/blob/fe7e6346fafd59051d1c79f4c7760cf3032af57e/src/symbols.js): typed references.

The parser implementation is new. The old regex-search tokenizer is not carried over.

## Grammar

The spaces and alternatives below are notation, not literal separators. The actual
format has no whitespace or commas between entries or fields.

```text
digit         = U+0100..U+D7FF | U+E000..U+FFFF
integer       = digit+
string-ref    = S integer
tuple-ref     = A integer
record-ref    = O integer
document-ref  = D integer : integer
revision-ref  = R integer
reference     = string-ref | tuple-ref | record-ref | document-ref | revision-ref
boolean       = T | F
basic         = boolean | V
number        = N integer
value         = basic | number | reference

string        = JSON string literal
tuple         = [ value* ]
record        = { tuple-ref tuple-ref }
document      = < string-ref >
revision      = ( document-ref record-ref (tuple-ref | record-ref) boolean )
entry         = string | tuple | record | document | revision | basic
file          = entry*
```

Document references contain the type ID, a literal ASCII `:`, and the Document's
local ID within that type. Both IDs use the existing compact integer encoding.
The delimiter separates their variable-length encodings. A Document reference
without the type ID and delimiter is rejected. `documentReference(typeId)(id)`
in `src/symbols.mjs` binds the type ID and constructs these references.

The record fields are keys Tuple, then values Tuple. Revision fields are Document,
metadata Record, data root, and archive state. Data roots accept Records and Tuples,
the native composite values specified for odbx. Historical `A` and `O` letters stay.

Document definitions keep the type String reference. Type IDs start at 1 and follow
the order in which distinct types first appear in Document definitions; they are
separate from StringStore IDs. Document IDs start at 1 within each type, and Revision
IDs start at 1 within each Document. These IDs remain implicit in their respective
definition sequences; the historical UUID String field is omitted.

The parser exposes syntax only. The future store/replay layer must maintain these
scopes and publish new type assignments with the transaction's complete Revision,
discarding provisional assignments on failure or an incomplete suffix.

Basic standalone `T`, `F`, and `V` entries retain the old grammar's syntax. Numbers
and typed references occur in value positions. Inline nested definitions and inline
strings in a Tuple are rejected; child values have their own earlier definitions.
BigInt `+`/`-` tokens and an `undefined` token are absent.

This is the specified rewrite format, not a reader for unchanged historical IDBX
files: the integer radix, Document identity, and supported value domain changed.

## Codec

`encodeInt` writes least-significant digits first in radix 63,232, skipping the UTF-16
surrogate hole. Zero has one digit, U+0100. `decodeInt` returns an internal `bigint`
without rounding large counters through a JavaScript Number. Encoders accept
nonnegative `bigint` or safe integer Number inputs.

`encodeFloat` preserves the old codec's integer arrangement: the Float64 low 32-bit
word occupies the integer's high word, and the Float64 high word occupies its low
word. Explicit little-endian DataView operations remove host-layout dependence.
For example, `1` maps to integer `0x3ff00000`, and `Number.MIN_VALUE` maps to
`0x0000000100000000`. The encoder normalizes `-0` to `+0`; NaN uses the runtime's
normal Float64 representation. Payloads above 64 bits are rejected on decoding.

`encodeString` uses the historical JSON string literal escaping, including escaped
lone surrogates. This only encodes StringStore entries; the database format remains
the compact grammar above. `encodePrimitive` handles null, Boolean, and Number.
Strings and composites must go through their stores.

## Parsed entries

`parse(input)` is a synchronous generator over a resident buffer. It does not buffer
the parsed file or perform filesystem I/O. It borrows byte input: callers must not
mutate the input while consuming the iterator. Offsets are relative to the supplied
input, including when it is a sliced byte view.

Every yielded object has `type`, `startOffset`, and exclusive `endOffset` in UTF-8
bytes, plus the following fields:

| Type | Fields |
| --- | --- |
| `string` | `value`: decoded JavaScript string |
| `tuple` | `values`: inline primitives or typed references |
| `record` | `keys`, `values`: Tuple references |
| `document` | `documentType`: String reference |
| `revision` | `document`, `metadata`, `data`: references; `archived`: Boolean |
| `primitive` | `value`: Boolean or null |

Document references have the shape `{ type: 'D', typeId: bigint, id: bigint }`.
Other references have the shape `{ type: 'S' | 'A' | 'O' | 'R', id: bigint }`.
These are parser descriptors, not a new user-storable value type. The later store
layer resolves references, checks existence and counter ranges, and reconstructs
canonical values. The parser accepts the historical reference letters in Tuple
syntax without asserting that they are valid values for a particular store.

`ParseError` extends `SyntaxError` and reports:

- `offset`: the failing byte position; input length when more bytes were required.
- `entryOffset`: the first byte of the entry that failed.
- `incomplete`: true for missing bytes at EOF, false for malformed syntax/encoding.

After a parse error the generator is closed. No part of the failing entry is yielded.
String contents validate JSON escapes and UTF-8, including overlong and surrogate
encodings. Literal U+FFFD remains valid; malformed bytes are never silently replaced
with it. File replay must pass bytes directly, rather than first calling `toString()`.

## Replay integration boundary

The parser yields definitions in physical order and exposes complete Revision
boundaries. It has no committed state. A syntactically valid Revision can still
contain unresolved references and is not, by itself, proof of a valid transaction.

The later replay implementation must provisionally reconstruct stores in sequence,
validate references and Revision semantics, and only then accept the Revision and
advance the committed byte offset. Completed definitions after the final accepted
Revision remain provisional even if parsing reaches EOF without an error. Replay
must discard that suffix and truncate it before writes resume, as required by §11.

Current tests exercise syntax boundaries at every byte of a sample stream. Actual
store rollback, reconstruction, and physical file truncation remain pending and
are tracked separately.

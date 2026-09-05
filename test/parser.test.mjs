import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, ParseError } from '../src/parser.mjs';
import { encodeInt, encodeFloat, encodeString, encodePrimitive } from '../src/codec.mjs';
import { documentReference } from '../src/symbols.mjs';

const ref = (type, id) => `${type}${encodeInt(id)}`;
const reference = (type, id) => ({ type, id: BigInt(id) });
const documentRef = (typeId, id) => `D${encodeInt(typeId)}:${encodeInt(id)}`;
const documentDescriptor = (typeId, id) => ({ type: 'D', typeId: BigInt(typeId), id: BigInt(id) });
const revision = (dataType = 'O', archived = false, typeId = 1, documentId = 1) =>
  `(${documentRef(typeId, documentId)}${ref('O', 0)}${ref(dataType, 0)}${archived ? 'T' : 'F'})`;
const values = input => [...parse(input)].map(({ startOffset, endOffset, ...entry }) => entry);

function failure(input, incomplete = false) {
  assert.throws(() => [...parse(input)], error => {
    assert.ok(error instanceof ParseError);
    assert.equal(error.incomplete, incomplete);
    assert.ok(Number.isSafeInteger(error.offset));
    assert.ok(error.offset >= error.entryOffset);
    return true;
  });
}

test('all definition forms parse in sequence with byte-accurate extents', () => {
  const text = 'Oddo é 😀';
  const definitions = [
    encodeString(text),
    `[${ref('S', 0)}TFVN${encodeFloat(1.5)}]`,
    `{${ref('A', 0)}${ref('A', 1)}}`,
    `<${ref('S', 0)}>`,
    revision(),
  ];
  assert.deepEqual(values(definitions.join('')), [
    { type: 'string', value: text },
    { type: 'tuple', values: [reference('S', 0), true, false, null, 1.5] },
    { type: 'record', keys: reference('A', 0), values: reference('A', 1) },
    { type: 'document', documentType: reference('S', 0) },
    { type: 'revision', document: documentDescriptor(1, 1), metadata: reference('O', 0),
      data: reference('O', 0), archived: false },
  ]);
  let offset = 0;
  const entries = [...parse(Buffer.from(definitions.join('')))];
  for (let i = 0; i < entries.length; i++) {
    assert.equal(entries[i].startOffset, offset);
    offset += Buffer.byteLength(definitions[i]);
    assert.equal(entries[i].endOffset, offset);
  }
});

test('empty input, empty definitions and historical standalone basic tokens', () => {
  assert.deepEqual([...parse('')], []);
  assert.deepEqual([...parse(Buffer.alloc(0))], []);
  assert.deepEqual(values('""[]TFV'), [
    { type: 'string', value: '' }, { type: 'tuple', values: [] },
    { type: 'primitive', value: true }, { type: 'primitive', value: false },
    { type: 'primitive', value: null },
  ]);
});

test('all reference letters and large IDs retain their separate namespaces', () => {
  const ids = [0n, 1n, 55_039n, 55_040n, 63_231n, 63_232n, 1n << 100n];
  for (const id of ids) {
    assert.deepEqual(values(`[${'SAOR'.split('').map(type => ref(type, id)).join('')}${documentRef(1, id)}]`), [
      { type: 'tuple', values: [...'SAOR'.split('').map(type => reference(type, id)), documentDescriptor(1, id)] },
    ]);
  }
});

test('Document reference factories bind the type and preserve separate local IDs', () => {
  const firstType = documentReference(1n);
  const secondType = documentReference(2n);
  const first = firstType(1n);
  const second = secondType(1n);
  assert.equal(`${first}`, 'D\u0101:\u0101');
  assert.equal(`${second}`, 'D\u0102:\u0101');
  assert.equal(`${firstType(2n)}`, 'D\u0101:\u0102');
  assert.equal(first.type, 'D');
  assert.equal(first.typeId, 1n);
  assert.equal(first.id, 1n);
  assert.deepEqual(values(`[${first}${second}]`), [{
    type: 'tuple', values: [documentDescriptor(1, 1), documentDescriptor(2, 1)],
  }]);
});

test('both Document reference components accept compact digit boundaries and large integers', () => {
  const ids = [0n, 1n, 55_039n, 55_040n, 63_231n, 63_232n, 1n << 100n];
  for (const typeId of ids) {
    for (const id of ids) {
      const token = documentReference(typeId)(id);
      const [entry] = parse(Buffer.from(`(${token}O\u0100A\u0100F)`));
      assert.deepEqual(entry.document, documentDescriptor(typeId, id));
    }
  }
});

test('Document references require a colon and both integer components', () => {
  for (const input of [
    '[D\u0101]', '[D:\u0101]', '[D\u0101:]', '[D\u0101::\u0102]',
    '[D\u0101:\u0102:\u0103]', '[D\u0101/\u0102]', '[D1:2]',
    '[D\u0101 :\u0102]', '[D\u0101: \u0102]',
    '(D\u0101O\u0100O\u0100F)',
  ]) failure(input);
  for (const input of ['[D', '[D\u0101', '[D\u0101:']) failure(input, true);
  for (const digit of ['\u0080', '\u00ff', '😀']) {
    failure(`[D${digit}:\u0101]`);
    failure(`[D\u0101:${digit}]`);
  }
});

test('every physical digit is accepted by the byte scanner', () => {
  let input = '[';
  for (let id = 0; id < 63_232; id++) input += ref('S', id);
  const [entry] = parse(Buffer.from(`${input}]`));
  assert.equal(entry.values.length, 63_232);
  entry.values.forEach((value, id) => assert.deepEqual(value, reference('S', id)));
});

test('Revision supports Record and Tuple data roots and both archive states', () => {
  for (const dataType of ['A', 'O']) {
    for (const archived of [true, false]) {
      const [entry] = parse(revision(dataType, archived));
      assert.equal(entry.data.type, dataType);
      assert.equal(entry.archived, archived);
    }
  }
});

test('string escaping, Unicode and lone surrogates round trip as string content', () => {
  const strings = [
    '', '"\\/\b\f\n\r\t', '\u0000\u001f', 'Oddo е 😀',
    '[]{}<>()SAODRNTFV+-:', '\u0100\ud7ff\ue000\uffff',
    '\ud800', '\udfff', '\ud800x\udfff', '\\u0100',
  ];
  for (const value of strings) assert.deepEqual(values(encodeString(value)), [{ type: 'string', value }]);
  assert.deepEqual(values('"\\/\\u0041\\u00e9\\uD83D\\uDE00"'), [{ type: 'string', value: '/Aé😀' }]);
});

test('all control characters are encoded and decoded without altering content', () => {
  for (let code = 0; code < 0x20; code++) {
    const value = String.fromCharCode(code);
    assert.deepEqual(values(encodeString(value)), [{ type: 'string', value }]);
    failure(`"${value}"`);
  }
});

test('Number values include finite extremes, infinities and NaN', () => {
  const numbers = [0, -0, 1, -1, 0.1, Math.PI, Number.MIN_VALUE, Number.MAX_VALUE, Infinity, -Infinity, NaN];
  const [entry] = parse(`[${numbers.map(encodePrimitive).join('')}]`);
  entry.values.forEach((value, i) => {
    if (Number.isNaN(numbers[i])) assert.ok(Number.isNaN(value));
    else assert.equal(value, Object.is(numbers[i], -0) ? 0 : numbers[i]);
  });
  failure(`[N${encodeInt(1n << 64n)}]`);
});

test('definitions enforce field types, arity, delimiters and flat child-first syntax', () => {
  const malformed = [
    ' ', '\n', ',', '#', 'N\u0100', 'S\u0100', '[[]]', '[{}]', '["inline"]', '[T,F]',
    '[T F]', '[X]', '[U]', '[+\u0100]', '[-\u0100]', '+\u0100', '-\u0100',
    '[N]', '[S]', '[A]', '[O]', '[D]', '[R]', '{}', '{A\u0100}',
    '{O\u0100A\u0100}', '{A\u0100S\u0100}', '{A\u0100A\u0100A\u0100}',
    '<>', '<N\u0100>', '<S\u0100S\u0101>', '<S\u0100T>',
    '()', '(S\u0100O\u0100O\u0100F)', '(D\u0101:\u0101A\u0100O\u0100F)',
    '(D\u0101:\u0101O\u0100S\u0100F)', '(D\u0101:\u0101O\u0100O\u0100V)',
    '(D\u0101:\u0101O\u0100O\u0100)', '(D\u0101:\u0101O\u0100O\u0100FF)',
    '(D\u0101:\u0101O\u0100O\u0100F]', '(D\u0101:\u0101O\u0100O\u0100 F)',
  ];
  for (const input of malformed) failure(input);
});

test('invalid JSON string escapes are rejected, including incomplete escapes', () => {
  for (const input of ['"\\x00"', '"\\v"', '"\\0"', '"\\uZZZZ"', '"\\u01"', '"\\\n"']) failure(input);
  for (const input of ['"', '"hello', '"\\', '"\\u', '"\\u0', '"\\u00', '"\\u000']) failure(input, true);
});

test('partial definitions and missing integer digits are incomplete at EOF', () => {
  for (const input of ['[', '[T', '[N', '[S', '[A\u0100', '{', '{A\u0100', '<S', '(D\u0101:\u0101O\u0100O\u0100F']) {
    failure(input, true);
  }
});

test('integer digits cannot use reserved code points, supplementary characters or replacement decoding', () => {
  for (const digit of ['\u0080', '\u00ff', '😀']) failure(`[S${digit}]`);
  // Malformed byte encodings must never silently decode as the valid U+FFFD digit.
  for (const bytes of [
    [0x80], [0xc0, 0x80], [0xc1, 0xbf], [0xc2, 0x20],
    [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf],
    [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff],
  ]) {
    failure(Buffer.from([0x5b, 0x53, ...bytes, 0x5d]));
    failure(Buffer.from([0x22, ...bytes, 0x22]));
  }
  assert.deepEqual(values('[S\ufffd]'), [{ type: 'tuple', values: [reference('S', 63_229)] }]);
});

test('UTF-8 prefixes ending mid-scalar are incomplete', () => {
  for (const bytes of [[0xc4], [0xe0], [0xe0, 0xa0], [0xf0], [0xf0, 0x9f], [0xf0, 0x9f, 0x98]]) {
    failure(Buffer.from([0x22, ...bytes]), true);
    failure(Buffer.from([0x5b, 0x53, ...bytes]), true);
  }
});

test('byte errors carry both the failing location and the start of the incomplete entry', () => {
  const prefix = encodeString('é😀');
  const offset = Buffer.byteLength(prefix);
  assert.throws(() => [...parse(`${prefix}[S]`)], error => {
    assert.equal(error.entryOffset, offset);
    assert.equal(error.offset, offset + 2);
    assert.equal(error.incomplete, false);
    return true;
  });
  assert.throws(() => [...parse(Buffer.concat([Buffer.from(prefix), Buffer.from([0x22, 0xe0, 0xa0])]))], error => {
    assert.equal(error.entryOffset, offset);
    assert.equal(error.offset, offset + 3);
    assert.equal(error.incomplete, true);
    return true;
  });
});

test('input is consumed lazily and complete entries survive a malformed suffix', () => {
  const entries = parse(Buffer.concat([Buffer.from(`"Oddo"${revision()}`), Buffer.from([0x22, 0xff])]));
  assert.equal(entries.next().value.type, 'string');
  assert.equal(entries.next().value.type, 'revision');
  assert.throws(() => entries.next(), ParseError);
  assert.equal(entries.next().done, true);
});

test('Buffer slices and Uint8Array views respect their own byte offsets and lengths', () => {
  const bytes = Buffer.from('garbage[TFV]garbage');
  const expected = [{ type: 'tuple', values: [true, false, null], startOffset: 0, endOffset: 5 }];
  assert.deepEqual([...parse(bytes.subarray(7, 12))], expected);
  assert.deepEqual([...parse(new Uint8Array(bytes.buffer, bytes.byteOffset + 7, 5))], expected);
});

test('invalid input types and raw unpaired surrogates are not silently converted', () => {
  for (const input of [null, undefined, 1, {}, [], new ArrayBuffer(0)]) {
    assert.throws(() => [...parse(input)], TypeError);
  }
  assert.throws(() => [...parse('"\ud800"')], TypeError);
  assert.throws(() => [...parse('[S\udfff]')], TypeError);
});

test('every byte truncation yields only completed entries and complete Revision boundaries', () => {
  const definitions = [
    '"type"', '<S\u0100>', '[]', '{A\u0100A\u0100}', revision(),
    encodeString('é 😀 \\ "\n'), `[S${encodeInt(55_040)}N${encodeFloat(Math.PI)}]`,
    '{A\u0100A\u0101}', revision('A', true, 63_232n, 1n << 100n), '"uncommitted definition"',
  ];
  const bytes = Buffer.from(definitions.join(''));
  const complete = [...parse(bytes)];
  for (let cut = 0; cut <= bytes.length; cut++) {
    const actual = [];
    try {
      for (const entry of parse(bytes.subarray(0, cut))) actual.push(entry);
    } catch (error) {
      assert.ok(error instanceof ParseError, `cut ${cut}`);
      assert.equal(error.incomplete, true, `cut ${cut}`);
      assert.equal(error.offset, cut, `cut ${cut}`);
    }
    const expected = complete.filter(entry => entry.endOffset <= cut);
    assert.deepEqual(actual, expected, `cut ${cut}`);
    const boundaries = actual.filter(entry => entry.type === 'revision').map(entry => entry.endOffset);
    assert.deepEqual(boundaries, complete.filter(entry => entry.type === 'revision' && entry.endOffset <= cut)
      .map(entry => entry.endOffset), `Revision boundaries at cut ${cut}`);
  }
});

test('uncommitted definitions do not create another Revision boundary', () => {
  const first = revision();
  const bytes = Buffer.from(`${first}"complete but provisional"[]`);
  const boundaries = [...parse(bytes)].filter(entry => entry.type === 'revision');
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].endOffset, Buffer.byteLength(first));
  assert.ok(boundaries[0].endOffset < bytes.length);
});

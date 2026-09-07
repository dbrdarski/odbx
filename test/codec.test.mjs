import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RADIX, decodeDigit, encodeInt, decodeInt, floatToInt, intToFloat,
  encodeFloat, decodeFloat, encodeString, encodePrimitive,
} from '../src/codec.mjs';

test('integer alphabet boundaries and historical digit order have fixed encodings', () => {
  const fixtures = [
    [0n, '\u0100'], [1n, '\u0101'], [255n, '\u01ff'], [256n, '\u0200'],
    [55_039n, '\ud7ff'], [55_040n, '\ue000'], [63_231n, '\uffff'],
    [63_232n, '\u0100\u0101'], [63_233n, '\u0101\u0101'],
    [RADIX ** 2n - 1n, '\uffff\uffff'],
    [RADIX ** 2n, '\u0100\u0100\u0101'],
  ];
  for (const [value, encoded] of fixtures) {
    assert.equal(encodeInt(value), encoded);
    assert.equal(decodeInt(encoded), value);
    assert.equal(decodeInt(Buffer.from(encoded).toString('utf8')), value);
  }
});

test('every one-digit value survives UTF-8 and skips the entire surrogate block', () => {
  const digits = new Set();
  for (let value = 0; value < Number(RADIX); value++) {
    const encoded = encodeInt(value);
    const code = encoded.charCodeAt(0);
    assert.equal(encoded.length, 1);
    assert.ok(code >= 0x100 && code <= 0xffff);
    assert.ok(code < 0xd800 || code > 0xdfff);
    assert.equal(decodeDigit(code), value);
    assert.equal(decodeInt(Buffer.from(encoded).toString('utf8')), BigInt(value));
    digits.add(encoded);
  }
  assert.equal(digits.size, Number(RADIX));
});

test('large counters round trip without Number precision loss', () => {
  for (const value of [Number.MAX_SAFE_INTEGER, 2n ** 64n - 1n, 2n ** 128n, 10n ** 100n]) {
    assert.equal(decodeInt(encodeInt(value)), BigInt(value));
  }
  // A redundant high zero was accepted by the historical decoder and is still valid.
  assert.equal(decodeInt('\u0101\u0100'), 1n);
});

test('integer codec rejects invalid numbers, empty payloads and non-digit code units', () => {
  for (const value of [-1, -1n, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encodeInt(value), RangeError);
  }
  for (const value of [null, undefined, true, '1', {}, []]) {
    assert.throws(() => encodeInt(value), TypeError);
  }
  for (const encoded of ['', 'A', '\u0000', '\u00ff', '\ud800', '\udfff', '😀', '\u0100A']) {
    assert.throws(() => decodeInt(encoded), RangeError);
  }
  assert.throws(() => decodeInt(1), TypeError);
  for (const code of [-1, 0xff, 0xd800, 0xdfff, 0x10000, 256.5, NaN, Infinity]) {
    assert.throws(() => decodeDigit(code), RangeError);
  }
});

test('Float64 fixed fixtures preserve the historical 32-bit word arrangement', () => {
  const fixtures = [
    [0, 0n], [-0, 0n], [1, 0x3ff0_0000n], [-2, 0xc000_0000n],
    [1.5, 0x3ff8_0000n], [Number.MIN_VALUE, 0x0000_0001_0000_0000n],
    [1 + Number.EPSILON, 0x0000_0001_3ff0_0000n],
    [Math.PI, 0x5444_2d18_4009_21fbn],
    [Number.MAX_VALUE, 0xffff_ffff_7fef_ffffn],
    [Infinity, 0x7ff0_0000n], [-Infinity, 0xfff0_0000n],
  ];
  for (const [value, bits] of fixtures) {
    assert.equal(floatToInt(value), bits);
    assert.equal(decodeInt(encodeFloat(value)), bits);
    assert.equal(intToFloat(bits), Object.is(value, -0) ? 0 : value);
    assert.equal(decodeFloat(encodeFloat(value)), Object.is(value, -0) ? 0 : value);
  }
  assert.equal(Object.is(decodeFloat(encodeFloat(-0)), -0), false);
  assert.ok(Number.isNaN(decodeFloat(encodeFloat(NaN))));
});

test('deterministic Float64 bit samples round trip through compact UTF-8', () => {
  let bits = 0x1234_5678_9abc_def0n;
  const mask = (1n << 64n) - 1n;
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 4096; i++) {
    bits = (bits * 6_364_136_223_846_793_005n + 1n) & mask;
    view.setBigUint64(0, bits, false);
    const value = view.getFloat64(0, false);
    const decoded = decodeFloat(Buffer.from(encodeFloat(value)).toString('utf8'));
    if (Number.isNaN(value)) assert.ok(Number.isNaN(decoded));
    else assert.equal(decoded, Object.is(value, -0) ? 0 : value);
  }
});

test('Float64 decoder rejects overflowing bit payloads instead of wrapping', () => {
  assert.throws(() => decodeFloat(encodeInt(1n << 64n)), RangeError);
  assert.throws(() => intToFloat(-1n), RangeError);
  assert.throws(() => encodeFloat(1n), TypeError);
  assert.throws(() => encodeFloat('1'), TypeError);
});

test('strings retain JSON escaping and inline values exclude BigInt and undefined', () => {
  assert.equal(encodeString('quote"\\\n\u0000\ud800'), '"quote\\"\\\\\\n\\u0000\\ud800"');
  assert.equal(encodeString('Oddo 😀'), '"Oddo 😀"');
  assert.equal(encodePrimitive(null), 'V');
  assert.equal(encodePrimitive(true), 'T');
  assert.equal(encodePrimitive(false), 'F');
  assert.equal(encodePrimitive(-0), 'N\u0100');
  assert.equal(decodeFloat(encodePrimitive(123.5).slice(1)), 123.5);
  for (const value of [undefined, 1n, 'inline string', [], {}]) {
    assert.throws(() => encodePrimitive(value), TypeError);
  }
  assert.throws(() => encodeString(undefined), TypeError);
});

export const RADIX = 63_232n;

const DIGIT_START = 0x100;
const SURROGATE_START = 0xd800;
const SURROGATE_END = 0xdfff;
const SURROGATE_WIDTH = 0x800;
const UINT32_MASK = 0xffff_ffffn;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

/** Decode one physical digit. The syntax region and surrogate hole are invalid. */
export function decodeDigit(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < DIGIT_START || codePoint > 0xffff ||
      (codePoint >= SURROGATE_START && codePoint <= SURROGATE_END)) {
    throw new RangeError('Invalid compact integer digit');
  }
  return codePoint - DIGIT_START - (codePoint > SURROGATE_END ? SURROGATE_WIDTH : 0);
}

function unsignedInteger(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('Expected a nonnegative safe integer');
    }
    return BigInt(value);
  }
  if (typeof value !== 'bigint') throw new TypeError('Expected an integer');
  if (value < 0n) throw new RangeError('Expected a nonnegative integer');
  return value;
}

/** Historical least-significant-digit-first encoding, with the surrogate hole skipped. */
export function encodeInt(value) {
  let remaining = unsignedInteger(value);
  let result = '';
  do {
    let codePoint = Number(remaining % RADIX) + DIGIT_START;
    if (codePoint >= SURROGATE_START) codePoint += SURROGATE_WIDTH;
    result += String.fromCharCode(codePoint);
    remaining /= RADIX;
  } while (remaining !== 0n);
  return result;
}

export function decodeInt(encoded) {
  if (typeof encoded !== 'string') throw new TypeError('Expected compact integer digits');
  if (encoded.length === 0) throw new RangeError('Expected at least one integer digit');
  let value = 0n;
  for (let i = encoded.length - 1; i >= 0; i--) {
    value = value * RADIX + BigInt(decodeDigit(encoded.charCodeAt(i)));
  }
  return value;
}

/**
 * IDBX places the Float64 low 32-bit word in the integer's high 32 bits.
 * Explicit little-endian reads preserve that representation on every host.
 */
export function floatToInt(value) {
  if (typeof value !== 'number') throw new TypeError('Expected a Number');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Object.is(value, -0) ? 0 : value, true);
  return (BigInt(view.getUint32(0, true)) << 32n) | BigInt(view.getUint32(4, true));
}

export function intToFloat(value) {
  const bits = unsignedInteger(value);
  if (bits > UINT64_MAX) throw new RangeError('Float64 payload exceeds 64 bits');
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, Number(bits >> 32n), true);
  view.setUint32(4, Number(bits & UINT32_MASK), true);
  return view.getFloat64(0, true);
}

export const encodeFloat = value => encodeInt(floatToInt(value));
export const decodeFloat = encoded => intToFloat(decodeInt(encoded));

/** Strings are separate store definitions using the original JSON string escaping. */
export function encodeString(value) {
  if (typeof value !== 'string') throw new TypeError('Expected a String');
  return JSON.stringify(value);
}

/** Strings and composites go through their stores, not this inline-value encoder. */
export function encodePrimitive(value) {
  if (value === null) return 'V';
  if (value === true) return 'T';
  if (value === false) return 'F';
  if (typeof value === 'number') return `N${encodeFloat(value)}`;
  throw new TypeError('Expected null, Boolean, or Number');
}

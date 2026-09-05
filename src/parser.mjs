import { Buffer } from 'node:buffer';
import { RADIX, decodeDigit, intToFloat } from './codec.mjs';

export class ParseError extends SyntaxError {
  constructor(message, offset, entryOffset, incomplete = false) {
    super(`${message} at byte ${offset}`);
    this.name = 'ParseError';
    this.offset = offset;
    this.entryOffset = entryOffset;
    this.incomplete = incomplete;
  }
}

/**
 * Yield complete entries in physical order without materializing a token array.
 * References are { type: 'S' | 'A' | 'O' | 'D' | 'R', id: bigint }.
 * Offsets are UTF-8 bytes, including for string input. Pass file bytes directly
 * so invalid UTF-8 in a torn suffix cannot be replaced during string decoding.
 *
 * Entries are provisional: the replay layer must resolve references and commit
 * stores/indexes only after accepting a complete Revision. This parser does no I/O.
 */
export function* parse(input) {
  const scanner = new Scanner(input);
  while (!scanner.eof) yield scanner.entry();
}

class Scanner {
  #bytes;
  #offset = 0;
  #entryOffset = 0;

  constructor(input) {
    if (typeof input === 'string') {
      if (!input.isWellFormed()) throw new TypeError('Input contains unpaired UTF-16 surrogates');
      this.#bytes = Buffer.from(input, 'utf8');
    } else if (input instanceof Uint8Array) {
      this.#bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    } else {
      throw new TypeError('Expected a string, Buffer, or Uint8Array');
    }
  }

  get eof() { return this.#offset === this.#bytes.length; }

  #fail(message, offset = this.#offset, incomplete = false) {
    throw new ParseError(message, offset, this.#entryOffset, incomplete);
  }

  #peek() {
    if (this.eof) this.#fail('Unexpected end of input', this.#offset, true);
    return String.fromCharCode(this.#bytes[this.#offset]);
  }

  #expect(character) {
    if (this.#peek() !== character) this.#fail(`Expected '${character}'`);
    this.#offset++;
  }

  // Validate one Unicode scalar locally. Decoding the entire file up front would
  // lose earlier complete entries when a later transaction ends in partial UTF-8.
  #scalar() {
    const start = this.#offset;
    const first = this.#bytes[this.#offset++];
    if (first < 0x80) return first;
    let length;
    let point;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
      point = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      point = first & 0x0f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      point = first & 0x07;
    } else {
      this.#fail('Invalid UTF-8 leading byte', start);
    }
    for (let i = 1; i < length; i++) {
      if (this.eof) this.#fail('Incomplete UTF-8 sequence', this.#offset, true);
      const next = this.#bytes[this.#offset];
      if (next < 0x80 || next > 0xbf || (i === 1 && (
        (first === 0xe0 && next < 0xa0) || (first === 0xed && next > 0x9f) ||
        (first === 0xf0 && next < 0x90) || (first === 0xf4 && next > 0x8f)
      ))) this.#fail('Invalid UTF-8 continuation byte');
      this.#offset++;
      point = (point << 6) | (next & 0x3f);
    }
    return point;
  }

  #integer() {
    const start = this.#offset;
    let result = 0n;
    let place = 1n;
    while (!this.eof && this.#bytes[this.#offset] >= 0x80) {
      const digitOffset = this.#offset;
      const point = this.#scalar();
      let digit;
      try {
        digit = decodeDigit(point);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        this.#fail('Invalid compact integer digit', digitOffset);
      }
      result += BigInt(digit) * place;
      place *= RADIX;
    }
    if (this.#offset === start) this.#fail('Expected compact integer digits', start, this.eof);
    return result;
  }

  #reference(types = 'SAODR') {
    const type = this.#peek();
    if (!types.includes(type)) this.#fail(`Expected ${types} reference`);
    this.#offset++;
    return { type, id: this.#integer() };
  }

  #boolean() {
    const token = this.#peek();
    if (token !== 'T' && token !== 'F') this.#fail('Expected Boolean');
    this.#offset++;
    return token === 'T';
  }

  #value() {
    const token = this.#peek();
    if (token === 'T' || token === 'F') return this.#boolean();
    if (token === 'V') {
      this.#offset++;
      return null;
    }
    if (token === 'N') {
      const start = this.#offset++;
      const bits = this.#integer();
      if (bits > 0xffff_ffff_ffff_ffffn) this.#fail('Float64 payload exceeds 64 bits', start);
      return intToFloat(bits);
    }
    if ('SAODR'.includes(token)) return this.#reference();
    this.#fail('Expected primitive or typed reference');
  }

  #string() {
    const start = this.#offset;
    this.#expect('"');
    while (true) {
      const token = this.#peek();
      const byte = this.#bytes[this.#offset];
      if (token === '"') {
        this.#offset++;
        return JSON.parse(this.#bytes.toString('utf8', start, this.#offset));
      }
      if (token === '\\') {
        this.#offset++;
        const escape = this.#peek();
        if (escape === 'u') {
          this.#offset++;
          for (let i = 0; i < 4; i++) {
            if (!'0123456789abcdefABCDEF'.includes(this.#peek())) this.#fail('Invalid Unicode escape');
            this.#offset++;
          }
        } else {
          if (!'"\\/bfnrt'.includes(escape)) this.#fail('Invalid string escape');
          this.#offset++;
        }
      } else {
        if (byte < 0x20) this.#fail('Unescaped control character in string');
        this.#scalar();
      }
    }
  }

  entry() {
    this.#entryOffset = this.#offset;
    const token = this.#peek();
    let entry;
    switch (token) {
      case '"':
        entry = { type: 'string', value: this.#string() };
        break;
      case '[': {
        this.#offset++;
        const values = [];
        while (this.#peek() !== ']') values.push(this.#value());
        this.#offset++;
        entry = { type: 'tuple', values };
        break;
      }
      case '{': {
        this.#offset++;
        const keys = this.#reference('A');
        const values = this.#reference('A');
        this.#expect('}');
        entry = { type: 'record', keys, values };
        break;
      }
      case '<': {
        this.#offset++;
        // Numeric Document identity comes from the store counter, replacing the
        // historical UUID String field. The type String reference remains.
        const documentType = this.#reference('S');
        this.#expect('>');
        entry = { type: 'document', documentType };
        break;
      }
      case '(': {
        this.#offset++;
        const document = this.#reference('D');
        const metadata = this.#reference('O');
        const data = this.#reference('AO');
        const archived = this.#boolean();
        this.#expect(')');
        entry = { type: 'revision', document, metadata, data, archived };
        break;
      }
      case 'T':
      case 'F':
      case 'V':
        entry = { type: 'primitive', value: this.#value() };
        break;
      default:
        this.#fail('Expected store definition or primitive');
    }
    return { ...entry, startOffset: this.#entryOffset, endOffset: this.#offset };
  }
}

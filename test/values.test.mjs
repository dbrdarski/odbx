import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Record, Tuple } from 'odbx';
import { Record as InternalRecord, Tuple as InternalTuple } from '../src/values.mjs';

test('Oddo runtime is byte-for-byte the pinned source, without local adaptations', async () => {
  const bytes = await readFile(new URL('../src/values.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '74f25dd7cd091e938c01d6fbbc19fcffe6831304ac9521d771aa016192e8ee53');
});

test('package exports and internal consumers share the same canonical runtime', () => {
  assert.equal(Record, InternalRecord);
  assert.equal(Tuple, InternalTuple);
  assert.equal(Record({ shared: Tuple('export') }), InternalRecord({ shared: InternalTuple('export') }));
});

test('Tuple is an ordered canonical sequence with the original nominal Array representation', () => {
  const tuple = Tuple(1, 2);
  assert.equal(tuple, Tuple(1, 2));
  assert.notEqual(tuple, Tuple(2, 1));
  assert.notEqual(tuple, Tuple(1));
  assert.notEqual(tuple, Tuple(1, 2, 3));
  assert.deepEqual([...tuple], [1, 2]);
  assert.equal(Array.isArray(tuple), true);
  assert.equal(tuple instanceof Tuple, true);
  assert.equal(tuple instanceof Array, true);
  assert.equal(tuple instanceof Record, false);
  assert.equal([] instanceof Tuple, false);
  assert.equal(Object.getPrototypeOf(tuple), Tuple.prototype);
  assert.equal(tuple.constructor, Tuple);
});

test('singleton Number Tuples retain their element instead of using Array length construction', () => {
  for (const value of [0, 2, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
    const tuple = Tuple(value);
    assert.equal(tuple.length, 1);
    assert.equal(tuple[0], value);
    assert.equal(Object.hasOwn(tuple, 0), true);
  }
  assert.notEqual(Tuple(2), Tuple(null, null));
  assert.notEqual(Tuple(0), Tuple());
});

test('empty containers are canonical and Record and Tuple namespaces are distinct', () => {
  assert.equal(Tuple(), Tuple());
  assert.equal(Tuple().length, 0);
  assert.equal(Record(), Record({}));
  assert.equal(Record(null), Record({}));
  assert.deepEqual(Object.keys(Record()), []);
  assert.notEqual(Tuple(), Record());
  assert.notEqual(Tuple('a', 1), Record({ a: 1 }));
});

test('Record retains the original nominal Object representation', () => {
  const record = Record({ nominal: true });
  assert.equal(record instanceof Record, true);
  assert.equal(record instanceof Object, true);
  assert.equal(record instanceof Tuple, false);
  assert.equal({} instanceof Record, false);
  assert.equal(Array.isArray(record), false);
  assert.equal(Object.getPrototypeOf(record), Record.prototype);
  assert.equal(record.constructor, Record);
  assert.equal(Record({ constructor: null }) instanceof Record, true);
});

test('all permutations of Record entries have one identity', () => {
  const entries = [['a', 1], ['b', false], ['c', null], ['d', Tuple('child')]];
  const expected = Record(Object.fromEntries(entries));
  function visit(prefix, remaining) {
    if (remaining.length === 0) {
      assert.equal(Record(Object.fromEntries(prefix)), expected);
      return;
    }
    remaining.forEach((entry, index) => visit([...prefix, entry], remaining.filter((_, i) => i !== index)));
  }
  visit([], entries);
  assert.notEqual(expected, Record({ a: 2, b: false, c: null, d: Tuple('child') }));
  assert.notEqual(Record({ a: 1 }), Record({ b: 1 }));
});

test('Record keys and values have deterministic matching enumeration order', () => {
  const entries = [
    ['z', 0], ['2', 1], ['a', 2], ['10', 3], ['01', 4], ['é', 5],
    ['__proto__', 6], ['constructor', 7], ['hasOwnProperty', 8],
  ];
  const record = Record(Object.fromEntries(entries));
  const reordered = Record(Object.fromEntries(entries.toReversed()));
  assert.equal(record, reordered);
  assert.deepEqual(Object.keys(record), ['2', '10', '01', '__proto__', 'a', 'constructor', 'hasOwnProperty', 'z', 'é']);
  assert.deepEqual(Object.values(record), [1, 3, 4, 6, 2, 7, 8, 0, 5]);
  assert.equal(Tuple(...Object.keys(record)), Tuple(...Object.keys(reordered)));
  assert.equal(Tuple(...Object.values(record)), Tuple(...Object.values(reordered)));
  assert.equal(Record(Object.fromEntries(Object.entries(record))), record);
});

test('Record copies __proto__ as an own data property without changing its prototype', () => {
  const props = Object.create(null);
  props.__proto__ = Tuple('ordinary data');
  const record = Record(props);
  assert.equal(Object.hasOwn(record, '__proto__'), true);
  assert.equal(record.__proto__, props.__proto__);
  assert.equal(Object.getPrototypeOf(record), Record.prototype);
  assert.deepEqual(Object.keys(record), ['__proto__']);
  assert.equal(record, Record({ ['__proto__']: Tuple('ordinary data') }));
});

test('Record keeps the source rule of copying only own enumerable string keys', () => {
  const props = Object.create({ inherited: 1 });
  Object.defineProperty(props, 'hidden', { value: 2 });
  props[Symbol('symbol key')] = 3;
  props.visible = 4;
  const record = Record(props);
  assert.equal(record, Record({ visible: 4 }));
  assert.deepEqual(Object.keys(record), ['visible']);
  assert.equal(Object.hasOwn(record, 'inherited'), false);
  assert.equal(Object.hasOwn(record, 'hidden'), false);
  assert.deepEqual(Object.getOwnPropertySymbols(record), []);
});

test('null Tuple elements are canonical and remain distinct from absent elements', () => {
  assert.equal(Tuple(null), Tuple(null));
  assert.equal(Tuple(null)[0], null);
  assert.equal(Tuple(null, null), Tuple(null, null));
  assert.notEqual(Tuple(), Tuple(null));
  assert.notEqual(Tuple(1), Tuple(1, null));
});

test('null Record fields are canonical and remain distinct from absent fields', () => {
  const record = Record({ order: 'present', value: null });
  assert.equal(record.value, null);
  assert.equal(record, Record({ value: null, order: 'present' }));
  assert.equal(Record({ ['__proto__']: null }).__proto__, null);
  assert.notEqual(Record({}), Record({ a: null }));
  assert.equal(Object.hasOwn(Record({ a: null }), 'a'), true);
});

test('constructors preserve permitted children without truthiness coercion', () => {
  const child = Record({ nested: true });
  const children = [null, false, true, 0, '', 'Oddo', 1, NaN, Infinity, -Infinity, child, Tuple('nested')];
  const tuple = Tuple(...children);
  const record = Record(Object.fromEntries(children.map((value, i) => [`key${i}`, value])));
  children.forEach((value, i) => {
    assert.equal(tuple[i], value);
    assert.equal(record[`key${i}`], value);
  });
  assert.notEqual(Tuple(1), Tuple('1'));
  assert.notEqual(Tuple(false), Tuple(0));
  assert.notEqual(Tuple(null), Tuple(false));
});

test('NaN and signed zero retain the source interner Map semantics', () => {
  assert.equal(Tuple('NaN', NaN), Tuple('NaN', Number('not a number')));
  assert.equal(Record({ value: NaN }), Record({ value: 0 / 0 }));
  const negativeFirst = Tuple('negative zero first', -0);
  assert.equal(negativeFirst, Tuple('negative zero first', 0));
  assert.equal(Object.is(negativeFirst[1], -0), true);
  const positiveFirst = Record({ key: 'positive zero first', value: 0 });
  assert.equal(positiveFirst, Record({ value: -0, key: 'positive zero first' }));
  assert.equal(Object.is(positiveFirst.value, -0), false);
});

test('constructors leave caller containers untouched and read each Record field once', () => {
  let reads = 0;
  const props = Object.freeze({ untouched: null, get once() { reads++; return 42; } });
  const args = Object.freeze([null, 'unchanged']);
  const record = Record(props);
  const tuple = Tuple(...args);
  assert.equal(reads, 1);
  assert.equal(props.untouched, null);
  assert.equal(args[0], null);
  assert.equal(record.untouched, null);
  assert.equal(record.once, 42);
  assert.equal(tuple[0], null);
});

test('parents reuse canonical children directly and edits rebuild only changed ancestors', () => {
  const child = Record({ content: Tuple('shared', null) });
  const parent = Record({ left: child, right: child, version: 1 });
  const equal = Record({ version: 1, right: Record({ content: Tuple('shared', null) }), left: child });
  assert.equal(parent, equal);
  assert.equal(parent.left, child);
  assert.equal(parent.left, parent.right);
  const updated = Record({ ...parent, version: 2 });
  assert.notEqual(updated, parent);
  assert.equal(updated.left, child);
  assert.equal(updated.right, child);
  assert.equal(parent.version, 1);
  assert.equal(updated, Record({ right: child, version: 2, left: child }));
});

test('independently constructed nested Record/Tuple values share canonical identity', () => {
  assert.equal(
    Record({ x: Tuple(1, Record({ y: Tuple(null, 'leaf') })) }),
    Record({ x: Tuple(1, Record({ y: Tuple(null, 'leaf') })) }),
  );
  assert.notEqual(
    Record({ x: Tuple(1, Record({ y: Tuple(null, 'leaf') })) }),
    Record({ x: Tuple(1, Record({ y: Tuple('leaf', null) })) }),
  );
});

test('one-level construction handles deep canonical children without recursive traversal', () => {
  let first = null;
  let second = null;
  for (let depth = 0; depth < 10_000; depth++) {
    first = depth % 2 ? Record({ child: first }) : Tuple(first);
    second = depth % 2 ? Record({ child: second }) : Tuple(second);
    assert.equal(first, second);
  }
});

test('retained canonical values keep identity across event-loop turns', async () => {
  const child = Tuple('retained', 123);
  const parent = Record({ retained: child });
  await setImmediate();
  assert.equal(child, Tuple('retained', 123));
  assert.equal(parent, Record({ retained: Tuple('retained', 123) }));
});

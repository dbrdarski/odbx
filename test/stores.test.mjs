import assert from 'node:assert/strict';
import test from 'node:test';
import { Record, Tuple } from 'odbx';
import { encodeFloat } from '../src/codec.mjs';
import { parse } from '../src/parser.mjs';
import { stringReference, tupleReference, recordReference } from '../src/symbols.mjs';
import { createStore, createStringStore, createTupleStore, createRecordStore, getKey, rollback } from '../src/stores.mjs';

const createStores = () => ({
  stringStore: createStringStore(),
  tupleStore: createTupleStore(),
  recordStore: createRecordStore(),
});

// The later serialized save path owns the counter forks, output and journal.
const prepare = stores => ({
  ...stores,
  counters: new Map(Object.values(stores).map(store => [store, { ...store.counter }])),
  output: [],
  created: [],
});
const publish = write => {
  for (const [store, counter] of write.counters) store.counter = counter;
};
const counters = stores => [stores.stringStore.counter.value, stores.tupleStore.counter.value, stores.recordStore.counter.value];
const pendingCounters = write => Array.from(write.counters.values(), counter => counter.value);
const payload = write => Buffer.from(write.output.join(''), 'utf8');

// Test-only definition inspection, not transactional database replay.
function inspect(bytes) {
  const values = { S: new Map(), A: new Map(), O: new Map() };
  const next = { S: 0n, A: 0n, O: 0n };
  function resolve(value) {
    if (value === null || typeof value !== 'object') return value;
    const table = values[value.type];
    assert.ok(table?.has(value.id), 'Every reference must follow its definition');
    return table.get(value.id);
  }
  for (const entry of parse(bytes)) {
    if (entry.type === 'string') values.S.set(next.S++, entry.value);
    else if (entry.type === 'tuple') values.A.set(next.A++, Tuple(...entry.values.map(resolve)));
    else if (entry.type === 'record') {
      const keys = resolve(entry.keys);
      const children = resolve(entry.values);
      assert.equal(keys.length, children.length);
      assert.ok(Array.from(keys).every(key => typeof key === 'string'));
      values.O.set(next.O++, Record(Object.fromEntries(Array.from(keys, (key, i) => [key, children[i]]))));
    } else assert.fail(`Unexpected ${entry.type} definition`);
  }
  return values;
}

test('createStore specializes reference construction and serialization once for independent stores', () => {
  let serializations = 0;
  let references = 0;
  const createUpperStore = createStore({
    reference: id => { references++; return `key:${id}`; },
    serialize: (_write, value) => { serializations++; return value.toUpperCase(); },
  });
  const store = createUpperStore();
  const write = prepare({ store });
  assert.equal(store.getKey(write, 'Oddo'), 'key:0');
  assert.equal(store.getKey(write, 'Oddo'), 'key:0');
  assert.deepEqual(write.output, ['ODDO']);
  assert.equal(serializations, 1);
  assert.equal(references, 1);
  assert.equal(store.counter.value, 0n);
  assert.equal(write.counters.get(store).value, 1n);
  const independent = createUpperStore();
  assert.equal(independent.getKey(prepare({ independent }), 'different'), 'key:0');
  publish(write);
  assert.equal(store.getKey(prepare({ store }), 'next'), 'key:1');
});

test('store matching is by value identity, never by serialized output', () => {
  const create = createStore({ reference: id => id, serialize: () => 'same definition' });
  const store = create();
  const write = prepare({ store });
  const first = {};
  assert.equal(store.getKey(write, first), 0n);
  assert.equal(store.getKey(write, first), 0n);
  assert.equal(store.getKey(write, {}), 1n);
  assert.deepEqual(write.output, ['same definition', 'same definition']);
});

test('store factories can resume restored counters and value mappings', () => {
  const known = stringReference(7n);
  const store = createStringStore(8n, new Map([['known', known]]));
  const write = prepare({ store });
  assert.equal(store.getKey(write, 'known'), known);
  assert.equal(store.getKey(write, 'next').id, 8n);
  assert.equal(store.counter.value, 8n);
  assert.equal(write.counters.get(store).value, 9n);
  assert.deepEqual(write.output, ['"next"']);
});

test('String, Tuple and Record counters are independent and change only in their forks', () => {
  const stores = createStores();
  const write = prepare(stores);
  const keys = [getKey(write, ''), getKey(write, Tuple()), getKey(write, Record())];
  assert.deepEqual(keys.map(key => [key.type, key.id]), [['S', 0n], ['A', 0n], ['O', 0n]]);
  assert.deepEqual(counters(stores), [0n, 0n, 0n]);
  assert.deepEqual(pendingCounters(write), [1n, 1n, 1n]);
  assert.deepEqual(write.output, ['""', '[]', '{A\u0100A\u0100}']);
});

test('StringStore preserves escaping and reuses references across writes', () => {
  const stores = createStores();
  const first = prepare(stores);
  const value = 'Oddo é 😀 " \\ \n\ud800';
  const key = getKey(first, value);
  assert.equal(`${key}`, 'S\u0100');
  assert.equal(getKey(first, `${value}`), key);
  assert.deepEqual(first.output, [JSON.stringify(value)]);
  assert.equal(inspect(payload(first)).S.get(0n), value);
  publish(first);
  const second = prepare(stores);
  assert.equal(getKey(second, value), key);
  assert.deepEqual(second.output, []);
  assert.deepEqual(second.created, []);
});

test('Tuple discovery emits shared children before their parent exactly once', () => {
  const write = prepare(createStores());
  const child = Tuple('shared', true);
  const parent = Tuple(child, child, false, null, 1.5);
  const key = getKey(write, parent);
  assert.equal(`${key}`, 'A\u0101');
  assert.deepEqual(write.output, ['"shared"', '[S\u0100T]', `[A\u0100A\u0100FVN${encodeFloat(1.5)}]`]);
  assert.equal(getKey(write, parent), key);
  assert.equal(write.output.length, 3);
  assert.equal(inspect(payload(write)).A.get(key.id), parent);
});

test('RecordStore decomposes a Record into canonical keys and values Tuples', () => {
  const write = prepare(createStores());
  const value = Record({ a: 1 });
  const key = getKey(write, value);
  assert.equal(`${key}`, 'O\u0100');
  assert.deepEqual(write.output, ['"a"', '[S\u0100]', `[N${encodeFloat(1)}]`, '{A\u0100A\u0101}']);
  assert.equal(inspect(payload(write)).O.get(key.id), value);
  assert.equal(getKey(write, Tuple('a')).id, 0n);
  assert.equal(getKey(write, Tuple(1)).id, 1n);
  assert.equal(write.output.length, 4);
});

test('an empty Record emits only one shared empty Tuple', () => {
  const write = prepare(createStores());
  getKey(write, Record());
  assert.deepEqual(write.output, ['[]', '{A\u0100A\u0100}']);
  assert.deepEqual(pendingCounters(write), [0n, 1n, 1n]);
});

test('Record key order, index-like keys and __proto__ retain corresponding values', () => {
  const write = prepare(createStores());
  const entries = [['10', 'ten'], ['2', 'two'], ['__proto__', 'data'], ['z', null], ['a', 0]];
  const value = Record(Object.fromEntries(entries));
  const key = getKey(write, value);
  const bytes = payload(write);
  assert.equal(getKey(write, Record(Object.fromEntries(entries.toReversed()))), key);
  assert.deepEqual(payload(write), bytes);
  const decoded = inspect(bytes).O.get(key.id);
  assert.equal(decoded, value);
  assert.equal(Object.hasOwn(decoded, '__proto__'), true);
  assert.equal(decoded.__proto__, 'data');
});

test('canonical children are reused across unrelated roots and writes', () => {
  const stores = createStores();
  const first = prepare(stores);
  const shared = Record({ values: Tuple('common', 7) });
  const left = Record({ left: shared });
  const leftKey = getKey(first, left);
  const sharedKey = getKey(first, shared);
  publish(first);
  const second = prepare(stores);
  const right = Record({ right: shared });
  const rightKey = getKey(second, right);
  assert.equal(getKey(second, shared), sharedKey);
  assert.equal([...parse(payload(second))].filter(entry => entry.type === 'record').length, 1);
  const decoded = inspect(Buffer.concat([payload(first), payload(second)]));
  assert.equal(decoded.O.get(leftKey.id), left);
  assert.equal(decoded.O.get(rightKey.id), right);
});

test('a persisted Tuple hit makes no descendant lookup', () => {
  const stores = createStores();
  const first = prepare(stores);
  const value = Tuple(Record({ leaf: 'known' }));
  const key = getKey(first, value);
  publish(first);
  const second = prepare(stores);
  second.stringStore.getKey = () => assert.fail('Visited persisted Tuple child');
  second.recordStore.getKey = () => assert.fail('Visited persisted Tuple child');
  assert.equal(getKey(second, value), key);
  assert.deepEqual(second.output, []);
});

test('a persisted Record hit does not decompose its keys or values again', () => {
  const stores = createStores();
  const first = prepare(stores);
  const value = Record({ leaf: Tuple('known') });
  const key = getKey(first, value);
  publish(first);
  const second = prepare(stores);
  second.tupleStore.getKey = () => assert.fail('Decomposed persisted Record');
  assert.equal(getKey(second, value), key);
  assert.deepEqual(second.output, []);
});

test('a reused child stops discovery inside a new parent', () => {
  const stores = createStores();
  const first = prepare(stores);
  const child = Tuple('known leaf');
  getKey(first, child);
  publish(first);
  const second = prepare(stores);
  const lookup = second.stringStore.getKey;
  second.stringStore.getKey = (write, value) => {
    assert.notEqual(value, 'known leaf', 'Visited an already persisted descendant');
    return lookup(write, value);
  };
  const parent = Record({ child });
  const key = getKey(second, parent);
  assert.equal(inspect(Buffer.concat([payload(first), payload(second)])).O.get(key.id), parent);
});

test('only counters are forked and published while stores and lookup functions remain stable', () => {
  const stores = createStores();
  const instances = Object.values(stores);
  const lookups = instances.map(store => store.getKey);
  const originalCounters = instances.map(store => store.counter);
  const first = prepare(stores);
  assert.equal(first.stringStore, stores.stringStore);
  assert.equal(first.tupleStore, stores.tupleStore);
  assert.equal(first.recordStore, stores.recordStore);
  for (const store of instances) assert.notEqual(first.counters.get(store), store.counter);
  getKey(first, Record({ first: Tuple('one') }));
  assert.deepEqual(counters(stores), [0n, 0n, 0n]);
  publish(first);
  assert.deepEqual(originalCounters.map(counter => counter.value), [0n, 0n, 0n]);
  for (const [i, store] of instances.entries()) {
    assert.equal(Object.values(stores)[i], store);
    assert.equal(store.getKey, lookups[i]);
    assert.equal(store.counter, first.counters.get(store));
  }
  const before = counters(stores);
  assert.ok(before.every(counter => counter > 0n));
  const second = prepare(stores);
  assert.equal(getKey(second, Record({ second: Tuple('two') })).id, before[2]);
  assert.deepEqual(counters(stores), before);
  assert.ok(pendingCounters(second).every((counter, i) => counter > before[i]));
});

test('rollback removes new mappings and retained failed values retry with identical IDs and definitions', () => {
  const stores = createStores();
  const committed = prepare(stores);
  const old = Record({ old: Tuple('committed') });
  const oldKey = getKey(committed, old);
  publish(committed);
  const before = counters(stores);
  const originalCounters = Object.values(stores).map(store => store.counter);
  const retained = Record({ new: Tuple('failed', Record({ nested: true })), old });
  const failed = prepare(stores);
  const key = getKey(failed, retained);
  const bytes = payload(failed);
  const journal = failed.created.slice();
  assert.ok(journal.every(([keys, value]) => keys.has(value)));
  rollback(failed.created);
  assert.ok(journal.every(([keys, value]) => !keys.has(value)));
  assert.deepEqual(failed.created, []);
  assert.deepEqual(counters(stores), before);
  Object.values(stores).forEach((store, i) => assert.equal(store.counter, originalCounters[i]));
  const retry = prepare(stores);
  assert.equal(getKey(retry, old), oldKey);
  assert.deepEqual(retry.output, []);
  assert.equal(`${getKey(retry, retained)}`, `${key}`);
  assert.deepEqual(payload(retry), bytes);
  assert.equal(inspect(Buffer.concat([payload(committed), payload(retry)])).O.get(key.id), retained);
  // An already-cleared journal cannot undo entries inserted by the retry.
  rollback(failed.created);
  publish(retry);
  const next = prepare(stores);
  getKey(next, retained);
  assert.deepEqual(next.output, []);
});

test('discovery failure after creating all three kinds of value is recoverable through the journal', () => {
  const stores = createStores();
  const child = Record({ valid: Tuple('new child') });
  const failed = prepare(stores);
  assert.throws(() => getKey(failed, Tuple(child, undefined)), TypeError);
  assert.ok(pendingCounters(failed).every(counter => counter > 0n));
  const journal = failed.created.slice();
  rollback(failed.created);
  assert.ok(journal.every(([keys, value]) => !keys.has(value)));
  assert.deepEqual(counters(stores), [0n, 0n, 0n]);
  const retry = prepare(stores);
  const key = getKey(retry, child);
  assert.equal(key.id, 0n);
  assert.equal(inspect(payload(retry)).O.get(key.id), child);
});

test('a definition-output failure still leaves every inserted mapping in the rollback journal', () => {
  const stores = createStores();
  const value = Record({ child: Tuple('new') });
  const failed = prepare(stores);
  const error = new Error('injected output failure');
  failed.output.push = definition => {
    if (definition.startsWith('{')) throw error;
    return Array.prototype.push.call(failed.output, definition);
  };
  assert.throws(() => getKey(failed, value), thrown => thrown === error);
  assert.ok(pendingCounters(failed).every(counter => counter > 0n));
  rollback(failed.created);
  const retry = prepare(stores);
  const key = getKey(retry, value);
  assert.equal(inspect(payload(retry)).O.get(key.id), value);
});

test('unsupported host values are rejected without modifying or normalizing Oddo values', () => {
  const invalid = [undefined, 1n, Symbol('host'), () => {}, {}, [], new Date(), stringReference(0n)];
  for (const value of invalid) {
    for (const root of [value, Tuple(value), Record({ value })]) {
      const stores = createStores();
      const write = prepare(stores);
      assert.throws(() => getKey(write, root), TypeError);
      rollback(write.created);
      assert.deepEqual(counters(stores), [0n, 0n, 0n]);
    }
  }
  assert.equal(Tuple(undefined)[0], undefined);
  assert.equal(Record({ value: undefined }).value, undefined);
});

test('inline primitives emit no definitions and negative-zero normalization stays in the codec', () => {
  const write = prepare(createStores());
  assert.equal(getKey(write, null), 'V');
  assert.equal(getKey(write, true), 'T');
  assert.equal(getKey(write, false), 'F');
  assert.equal(getKey(write, -0), 'N\u0100');
  assert.deepEqual(write.output, []);
  const value = Tuple('store signed-zero test', -0, NaN, Infinity, -Infinity);
  getKey(write, value);
  const tuple = [...parse(payload(write))].find(entry => entry.type === 'tuple');
  assert.equal(Object.is(value[1], -0), true);
  assert.equal(Object.is(tuple.values[1], -0), false);
  assert.ok(Number.isNaN(tuple.values[2]));
  assert.equal(tuple.values[3], Infinity);
  assert.equal(tuple.values[4], -Infinity);
});

test('separate databases assign independent IDs to the same canonical values', () => {
  const leftStores = createStores();
  const rightStores = createStores();
  const left = prepare(leftStores);
  getKey(left, Record({ seed: 'left only' }));
  publish(left);
  const first = prepare(leftStores);
  const right = prepare(rightStores);
  const common = Record({ common: Tuple(42) });
  assert.equal(getKey(first, common).id, 1n);
  const rightKey = getKey(right, common);
  assert.equal(rightKey.id, 0n);
  rollback(first.created);
  publish(right);
  const next = prepare(rightStores);
  assert.equal(getKey(next, common), rightKey);
  assert.deepEqual(next.output, []);
});

test('one collected output encodes into an independent UTF-8 buffer', () => {
  const write = prepare(createStores());
  const value = Tuple('é😀', '"\\\ud800');
  const key = getKey(write, value);
  const text = write.output.join('');
  const bytes = payload(write);
  assert.equal(bytes.length, Buffer.byteLength(text));
  assert.ok(bytes.length > text.length);
  assert.equal(inspect(bytes).A.get(key.id), value);
  bytes.fill(0);
  assert.equal(payload(write).toString('utf8'), text);
});

test('typed references retain their bigint IDs and compact namespace letters', () => {
  for (const [type, reference] of [['S', stringReference], ['A', tupleReference], ['O', recordReference]]) {
    const key = reference(63_232n);
    assert.equal(key.type, type);
    assert.equal(key.id, 63_232n);
    assert.equal(`${key}`, `${type}\u0100\u0101`);
    assert.deepEqual([...parse(`[${key}]`)][0].values, [{ type, id: key.id }]);
  }
});

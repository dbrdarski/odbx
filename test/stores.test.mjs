import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Record, Tuple } from 'odbx';
import { encodeFloat, encodeString } from '../src/codec.mjs';
import { parse } from '../src/parser.mjs';
import { init } from '../src/init.mjs';
import { createWrite } from '../src/write.mjs';
import { fileAdapter } from '../src/adapters/file.mjs';
import { stringReference, tupleReference, recordReference } from '../src/symbols.mjs';
import { createStore, createStringStore, getKey } from '../src/stores.mjs';

// Filesystem fixture only; store construction and the write lifecycle are in src.
async function temporaryFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'odbx-stores-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'values.odbx');
}

test('createStore specializes reference construction and serialization for independent stores', async t => {
  const filename = await temporaryFile(t);
  let serializations = 0;
  let references = 0;
  const createUpperStore = createStore({
    reference: id => { references++; return `key:${id}`; },
    serialize: (_, value) => { serializations++; return value.toUpperCase(); },
  });
  const store = createUpperStore();
  const write = createWrite({ store }, fileAdapter(filename), store.getKey);
  assert.equal(await write('Oddo'), 'key:0');
  assert.equal(await write('Oddo'), 'key:0');
  assert.equal(serializations, 1);
  assert.equal(references, 1);
  assert.equal(await write('next'), 'key:1');
  assert.equal(await readFile(filename, 'utf8'), 'ODDONEXT');
  const independent = createUpperStore();
  const other = createWrite({ independent }, fileAdapter(await temporaryFile(t)), independent.getKey);
  assert.equal(await other('different'), 'key:0');
});

test('store matching is by canonical value identity, never by serialized output', async t => {
  const filename = await temporaryFile(t);
  const store = createStore({ reference: id => id, serialize: () => 'same definition' })();
  const write = createWrite({ store }, fileAdapter(filename), store.getKey);
  assert.equal(await write(Record({ a: 1 })), 0n);
  assert.equal(await write(Record({ a: 1 })), 0n);
  assert.equal(await write(Record({ a: 2 })), 1n);
  assert.equal(await readFile(filename, 'utf8'), 'same definitionsame definition');
});

test('store factories can resume restored counters and value mappings', async t => {
  const filename = await temporaryFile(t);
  const known = stringReference(7n);
  const store = createStringStore(8n, new Map([['known', known]]));
  const write = createWrite({ store }, fileAdapter(filename), store.getKey);
  assert.equal(await write('known'), known);
  assert.equal((await write('next')).id, 8n);
  assert.equal(store.counter.fork().getId(), 9n);
  assert.equal(await readFile(filename, 'utf8'), '"next"');
});

test('String, Tuple and Record stores have independent counters', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const write = createWrite(stores, fileAdapter(filename));
  const keys = [await write(''), await write(Tuple()), await write(Record())];
  assert.deepEqual(keys.map(key => [key.type, key.id]), [['S', 0n], ['A', 0n], ['O', 0n]]);
  assert.deepEqual(Object.values(stores).map(store => store.counter.fork().getId()), [1n, 1n, 1n]);
  assert.equal(await readFile(filename, 'utf8'), '""[]{A\u0100A\u0100}');
});

test('StringStore preserves escaping and reuses references across writes', async t => {
  const filename = await temporaryFile(t);
  const write = createWrite(init(), fileAdapter(filename));
  const value = 'Oddo é 😀 " \\ \n\ud800';
  const key = await write(value);
  assert.equal(`${key}`, 'S\u0100');
  assert.equal(await write(`${value}`), key);
  assert.equal(await readFile(filename, 'utf8'), JSON.stringify(value));
  assert.equal([...parse(await readFile(filename))][0].value, value);
});

test('Tuple discovery emits shared children before their parent exactly once', async t => {
  const filename = await temporaryFile(t);
  const write = createWrite(init(), fileAdapter(filename));
  const child = Tuple('shared', true);
  const parent = Tuple(child, child, false, null, 1.5);
  const key = await write(parent);
  assert.equal(`${key}`, 'A\u0101');
  assert.equal(await write(parent), key);
  assert.equal(await readFile(filename, 'utf8'), `"shared"[S\u0100T][A\u0100A\u0100FVN${encodeFloat(1.5)}]`);
});

test('RecordStore decomposes a Record into shared canonical keys and values Tuples', async t => {
  const filename = await temporaryFile(t);
  const write = createWrite(init(), fileAdapter(filename));
  const value = Record({ a: 1 });
  const key = await write(value);
  assert.equal(`${key}`, 'O\u0100');
  assert.equal((await write(Tuple('a'))).id, 0n);
  assert.equal((await write(Tuple(1))).id, 1n);
  assert.equal(await write(value), key);
  assert.equal(await readFile(filename, 'utf8'), `"a"[S\u0100][N${encodeFloat(1)}]{A\u0100A\u0101}`);
});

test('an empty Record emits only one shared empty Tuple', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  await createWrite(stores, fileAdapter(filename))(Record());
  assert.equal(await readFile(filename, 'utf8'), '[]{A\u0100A\u0100}');
  assert.deepEqual(Object.values(stores).map(store => store.counter.fork().getId()), [0n, 1n, 1n]);
});

test('Record key order, index-like keys and __proto__ retain corresponding values', async t => {
  const filename = await temporaryFile(t);
  const write = createWrite(init(), fileAdapter(filename));
  const entries = [['10', 'ten'], ['2', 'two'], ['__proto__', 'data'], ['z', null], ['a', 0]];
  const key = await write(Record(Object.fromEntries(entries)));
  const bytes = await readFile(filename);
  assert.equal(await write(Record(Object.fromEntries(entries.toReversed()))), key);
  assert.deepEqual(await readFile(filename), bytes);
  const definitions = [...parse(bytes)];
  assert.deepEqual(definitions.filter(entry => entry.type === 'string').map(entry => entry.value),
    ['2', '10', '__proto__', 'a', 'z', 'two', 'ten', 'data']);
  assert.deepEqual(definitions.filter(entry => entry.type === 'tuple').map(entry => entry.values), [
    [0n, 1n, 2n, 3n, 4n].map(id => ({ type: 'S', id })),
    [{ type: 'S', id: 5n }, { type: 'S', id: 6n }, { type: 'S', id: 7n }, 0, null],
  ]);
  const record = definitions.at(-1);
  assert.deepEqual(record.keys, { type: 'A', id: 0n });
  assert.deepEqual(record.values, { type: 'A', id: 1n });
});

test('canonical children are reused across unrelated roots and writes', async t => {
  const filename = await temporaryFile(t);
  const write = createWrite(init(), fileAdapter(filename));
  const shared = Record({ values: Tuple('common', 7) });
  const leftKey = await write(Record({ left: shared }));
  const sharedKey = await write(shared);
  const sharedValuesKey = await write(Tuple(shared));
  const before = (await readFile(filename)).length;
  const rightKey = await write(Record({ right: shared }));
  assert.equal(await write(shared), sharedKey);
  assert.equal(rightKey.id, leftKey.id + 1n);
  const added = [...parse((await readFile(filename)).subarray(before))];
  assert.deepEqual(added.map(entry => entry.type), ['string', 'tuple', 'record']);
  assert.equal(added[0].value, 'right');
  assert.deepEqual(added[2].values, { type: 'A', id: sharedValuesKey.id });
});

test('a persisted Tuple hit makes no descendant lookup', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const write = createWrite(stores, fileAdapter(filename));
  const value = Tuple(Record({ leaf: 'known' }));
  const key = await write(value);
  const before = await readFile(filename);
  stores.stringStore.getKey = () => assert.fail('Visited persisted Tuple child');
  stores.recordStore.getKey = () => assert.fail('Visited persisted Tuple child');
  assert.equal(await write(value), key);
  assert.deepEqual(await readFile(filename), before);
});

test('a persisted Record hit does not decompose its keys or values again', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const write = createWrite(stores, fileAdapter(filename));
  const value = Record({ leaf: Tuple('known') });
  const key = await write(value);
  const before = await readFile(filename);
  stores.tupleStore.getKey = () => assert.fail('Decomposed persisted Record');
  assert.equal(await write(value), key);
  assert.deepEqual(await readFile(filename), before);
});

test('a reused child stops discovery inside a new parent', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const write = createWrite(stores, fileAdapter(filename));
  const childKey = await write(Tuple('known leaf'));
  const before = (await readFile(filename)).length;
  const lookup = stores.stringStore.getKey;
  stores.stringStore.getKey = (transaction, value) => {
    assert.equal(value, 'child', 'Only the new field name needs a string lookup');
    return lookup(transaction, value);
  };
  await write(Record({ child: Tuple('known leaf') }));
  assert.equal((await readFile(filename)).subarray(before).toString('utf8'),
    `"child"[S\u0101][${childKey}]{A\u0101A\u0102}`);
});

test('only counters are forked and adopted; stores and lookup functions remain stable', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const instances = Object.values(stores);
  const lookups = instances.map(store => store.getKey);
  const originalCounters = instances.map(store => store.counter);
  const write = createWrite(stores, fileAdapter(filename));
  await write(Record({ first: Tuple('one') }));
  assert.deepEqual(originalCounters.map(counter => counter.fork().getId()), [0n, 0n, 0n]);
  for (const [i, store] of instances.entries()) {
    assert.equal(Object.values(stores)[i], store);
    assert.equal(store.getKey, lookups[i]);
    assert.notEqual(store.counter, originalCounters[i]);
  }
  const before = instances.map(store => store.counter.fork().getId());
  assert.ok(before.every(id => id > 0n));
  assert.equal((await write(Record({ second: Tuple('two') }))).id, before[2]);
  assert.ok(instances.every((store, i) => store.counter.fork().getId() > before[i]));
});

test('a serializer failure removes speculative mappings without calling the adapter', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const error = new Error('injected serialization failure');
  let journal;
  stores.stringStore = createStore({
    reference: stringReference,
    serialize: (transaction, value) => {
      if (value === 'fail here') {
        journal = transaction.created.slice();
        throw error;
      }
      return encodeString(value);
    },
  })();
  const adapter = fileAdapter(filename);
  const append = t.mock.method(adapter, 'write');
  const truncate = t.mock.method(adapter, 'truncate');
  const write = createWrite(stores, adapter);
  const child = Record({ valid: Tuple('new child') });
  await assert.rejects(write(Tuple(child, 'fail here')), thrown => thrown === error);
  assert.equal(append.mock.callCount(), 0);
  assert.equal(truncate.mock.callCount(), 0);
  assert.ok(journal.length > 0);
  assert.ok(journal.every(([keys, value]) => !keys.has(value)));
  assert.deepEqual(Object.values(stores).map(store => store.counter.fork().getId()), [0n, 0n, 0n]);
  assert.equal((await write(child)).id, 0n);
  assert.deepEqual([...parse(await readFile(filename))].map(entry => entry.type),
    ['string', 'tuple', 'string', 'tuple', 'tuple', 'record']);
});

test('a definition-output failure rolls back every inserted mapping', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const error = new Error('injected output failure');
  let fail = true;
  let journal;
  const write = createWrite(stores, fileAdapter(filename), (transaction, value) => {
    if (fail) transaction.output.push = definition => {
      if (definition.startsWith('{')) {
        journal = transaction.created.slice();
        throw error;
      }
      return Array.prototype.push.call(transaction.output, definition);
    };
    return getKey(transaction, value);
  });
  const value = Record({ child: Tuple('new') });
  await assert.rejects(write(value), thrown => thrown === error);
  assert.ok(journal.every(([keys, child]) => !keys.has(child)));
  assert.deepEqual(Object.values(stores).map(store => store.counter.fork().getId()), [0n, 0n, 0n]);
  fail = false;
  assert.equal((await write(value)).id, 0n);
  assert.equal(await readFile(filename, 'utf8'), '"child"[S\u0100]"new"[S\u0101][A\u0101]{A\u0100A\u0102}');
});

test('inline primitives emit no definitions and negative-zero normalization stays in the codec', async t => {
  const filename = await temporaryFile(t);
  const write = createWrite(init(), fileAdapter(filename));
  assert.equal(await write(null), 'V');
  assert.equal(await write(true), 'T');
  assert.equal(await write(false), 'F');
  assert.equal(await write(-0), 'N\u0100');
  assert.equal(await readFile(filename, 'utf8'), '');
  const value = Tuple('store signed-zero test', -0, NaN, Infinity, -Infinity);
  await write(value);
  const tuple = [...parse(await readFile(filename))].find(entry => entry.type === 'tuple');
  assert.equal(Object.is(value[1], -0), true);
  assert.equal(Object.is(tuple.values[1], -0), false);
  assert.ok(Number.isNaN(tuple.values[2]));
  assert.equal(tuple.values[3], Infinity);
  assert.equal(tuple.values[4], -Infinity);
});

test('separate store sets assign independent IDs to the same canonical values', async t => {
  const left = createWrite(init(), fileAdapter(await temporaryFile(t)));
  const right = createWrite(init(), fileAdapter(await temporaryFile(t)));
  await left(Record({ seed: 'left only' }));
  const common = Record({ common: Tuple(42) });
  assert.equal((await left(common)).id, 1n);
  const rightKey = await right(common);
  assert.equal(rightKey.id, 0n);
  assert.equal(await right(common), rightKey);
});

test('one write passes an encoded UTF-8 buffer to the filesystem adapter', async t => {
  const filename = await temporaryFile(t);
  const adapter = fileAdapter(filename);
  const append = t.mock.method(adapter, 'write');
  const write = createWrite(init(), adapter);
  const key = await write(Tuple('é😀', '"\\\ud800'));
  assert.equal(append.mock.callCount(), 1);
  const [bytes] = append.mock.calls[0].arguments;
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual(await readFile(filename), bytes);
  assert.ok(bytes.length > bytes.toString('utf8').length);
  assert.equal(key.id, 0n);
  const definitions = [...parse(bytes)];
  assert.deepEqual(definitions.slice(0, 2).map(entry => entry.value), ['é😀', '"\\\ud800']);
  assert.deepEqual(definitions[2].values, [{ type: 'S', id: 0n }, { type: 'S', id: 1n }]);
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

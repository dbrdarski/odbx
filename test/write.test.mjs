import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Record, Tuple } from 'odbx';
import { init } from '../src/init.mjs';
import { createWrite } from '../src/write.mjs';
import { fileAdapter } from '../src/adapters/file.mjs';
import { createStore, createStringStore } from '../src/stores.mjs';
import { stringReference } from '../src/symbols.mjs';
import { encodeString } from '../src/codec.mjs';

async function temporaryFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'odbx-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'values.odbx');
}

test('the queue covers discovery and resolves each write only after append and counter publication', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const discovered = [];
  let transaction;
  stores.stringStore = createStore({
    reference: stringReference,
    serialize: (state, value) => {
      transaction = state;
      discovered.push(value);
      return encodeString(value);
    },
  })();
  const instances = Object.values(stores);
  const committed = instances.map(store => store.counter);
  const file = fileAdapter(filename);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let calls = 0;
  const write = createWrite(stores, {
    ...file,
    async write(bytes) {
      if (++calls === 1) {
        started.resolve();
        await release.promise;
      }
      await file.write(bytes);
    },
  });
  let settled = false;
  const first = write('one').then(key => {
    settled = true;
    assert.equal(stores.stringStore.counter.fork().getId(), 1n);
    return key;
  });
  const second = write('two');
  await started.promise;
  assert.equal(settled, false);
  assert.equal(calls, 1);
  assert.deepEqual(discovered, ['one']);
  for (const [i, store] of instances.entries()) {
    assert.equal(store.counter, committed[i]);
    assert.equal(transaction[Object.keys(stores)[i]], store);
    assert.notEqual(transaction.counters.get(store), store.counter);
    assert.equal(store.counter.fork().getId(), 0n);
  }
  assert.equal(transaction.counters.get(stores.stringStore).fork().getId(), 1n);
  release.resolve();
  assert.equal((await first).id, 0n);
  assert.equal((await second).id, 1n);
  assert.deepEqual(discovered, ['one', 'two']);
  assert.equal(await readFile(filename, 'utf8'), '"one""two"');
  assert.deepEqual(committed.map(counter => counter.fork().getId()), [0n, 0n, 0n]);
});

test('every partial append rolls back retained values and retries with the same bytes and IDs', async t => {
  const old = Record({ old: Tuple('committed é😀') });
  const retained = Record({ fresh: Tuple('failed é😀', Record({ nested: true })), old });
  let payloadLength = 1;
  for (let prefix = 0; prefix <= payloadLength; prefix++) {
    const filename = await temporaryFile(t);
    const stores = init();
    const file = fileAdapter(filename);
    const error = new Error(`failure after ${prefix} bytes`);
    let fail = false;
    let failedBytes;
    let retriedBytes;
    let truncatedTo;
    const write = createWrite(stores, {
      async write(bytes) {
        if (fail) {
          failedBytes = Buffer.from(bytes);
          await file.write(bytes.subarray(0, prefix));
          throw error;
        }
        retriedBytes = Buffer.from(bytes);
        await file.write(bytes);
      },
      async truncate(offset) {
        truncatedTo = offset;
        await file.truncate(offset);
      },
    });
    const oldKey = await write(old);
    const committedBytes = await readFile(filename);
    const committedCounters = Object.values(stores).map(store => store.counter);
    const nextRecordId = stores.recordStore.counter.fork().getId();
    fail = true;
    await assert.rejects(write(retained), thrown => thrown === error);
    payloadLength = failedBytes.length;
    assert.equal(truncatedTo, committedBytes.length);
    assert.deepEqual(await readFile(filename), committedBytes);
    Object.values(stores).forEach((store, i) => assert.equal(store.counter, committedCounters[i]));
    fail = false;
    assert.equal(await write(old), oldKey);
    assert.equal(retriedBytes.length, 0);
    const key = await write(retained);
    assert.equal(key.id, nextRecordId + 1n); // The new nested Record comes first.
    assert.deepEqual(retriedBytes, failedBytes);
    assert.deepEqual(await readFile(filename), Buffer.concat([committedBytes, failedBytes]));
    assert.equal(await write(retained), key);
    assert.equal(retriedBytes.length, 0);
  }
});

test('a failed append rejects and the next discovery starts only after truncation completes', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  const discovered = [];
  stores.stringStore = createStore({
    reference: stringReference,
    serialize: (_, value) => { discovered.push(value); return encodeString(value); },
  })();
  const file = fileAdapter(filename);
  const error = new Error('append failed');
  const truncating = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let fail = true;
  const write = createWrite(stores, {
    async write(bytes) {
      if (fail) {
        fail = false;
        await file.write(bytes.subarray(0, 2));
        throw error;
      }
      await file.write(bytes);
    },
    async truncate(offset) {
      truncating.resolve();
      await release.promise;
      await file.truncate(offset);
    },
  });
  let settled = false;
  const rejected = assert.rejects(write('failed'), thrown => {
    settled = true;
    return thrown === error;
  });
  const next = write('next');
  await truncating.promise;
  assert.equal(settled, false);
  assert.deepEqual(discovered, ['failed']);
  assert.equal(stores.stringStore.counter.fork().getId(), 0n);
  release.resolve();
  await rejected;
  assert.equal((await next).id, 0n);
  assert.deepEqual(discovered, ['failed', 'next']);
  assert.equal(await readFile(filename, 'utf8'), '"next"');
});

test('failed truncation blocks queued and future writes before discovery', async t => {
  const filename = await temporaryFile(t);
  const stores = init();
  let discoveries = 0;
  stores.stringStore = createStore({
    reference: stringReference,
    serialize: (_, value) => { discoveries++; return encodeString(value); },
  })();
  const file = fileAdapter(filename);
  const appendError = new Error('append failed');
  const truncateError = new Error('truncate failed');
  let appends = 0;
  let truncations = 0;
  const write = createWrite(stores, {
    async write(bytes) {
      appends++;
      await file.write(bytes.subarray(0, 1));
      throw appendError;
    },
    async truncate() { truncations++; throw truncateError; },
  });
  const outcomes = await Promise.allSettled([write('failed'), write('queued')]);
  const failure = outcomes[0].reason;
  assert.equal(outcomes[0].status, 'rejected');
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [appendError, truncateError]);
  assert.equal(outcomes[1].reason, failure);
  await assert.rejects(write('later'), error => error === failure);
  assert.equal(discoveries, 1);
  assert.equal(appends, 1);
  assert.equal(truncations, 1);
  assert.equal(stores.stringStore.counter.fork().getId(), 0n);
});

test('a restored writer truncates to the supplied byte offset and advances it after success', async t => {
  const filename = await temporaryFile(t);
  const prefix = Buffer.from('"restored é😀"');
  await writeFile(filename, prefix);
  const stores = init();
  stores.stringStore = createStringStore(1n, new Map([['restored é😀', stringReference(0n)]]));
  const file = fileAdapter(filename);
  let fail = false;
  const write = createWrite(stores, {
    async write(bytes) {
      await file.write(bytes);
      if (fail) throw new Error('failed after a complete append');
    },
    truncate: file.truncate,
  }, undefined, prefix.length);
  await write('new é😀');
  const committed = await readFile(filename);
  assert.ok(committed.length > prefix.length);
  fail = true;
  await assert.rejects(write('failed'));
  assert.deepEqual(await readFile(filename), committed);
});

import assert from "node:assert/strict";
import test from "node:test";
import { encodeString } from "../src/codec.mjs";
import { commit, createCommit } from "../src/commit.mjs";
import { parse } from "../src/parser.mjs";
import { createStores } from "../src/stores.mjs";
import { stringReference } from "../src/symbols.mjs";
import { Record, Tuple } from "../src/values.mjs";
import { createWriter } from "../src/writer.mjs";

test("a failed queued commit restores its store state and does not block the retry", async () => {
  const { stringStore } = createStores();
  const failure = Error("write failed");
  const payloads = [];
  const save = createCommit([stringStore], payload => {
    payloads.push(payload);
    return payloads.length === 1 ? Promise.reject(failure) : Promise.resolve();
  });
  const value = "retained";
  const failed = save(write => stringStore.getKey(write, value));
  const retried = save(write => stringStore.getKey(write, value));

  await assert.rejects(failed, error => error === failure);
  assert.equal(await retried, stringReference(0));
  assert.deepEqual(payloads, [encodeString(value), encodeString(value)]);
});

test("canonical values and shared children are persisted once", async () => {
  const stores = createStores();
  const payloads = [];
  const save = value => commit(
    [stores.stringStore, stores.tupleStore, stores.recordStore],
    payload => void payloads.push(payload),
    write => stores.getKey(write, value),
  );
  const shared = Record({ value: "shared" });

  await save(Tuple(shared, shared));
  await save(Tuple(Record({ value: "shared" }), Record({ value: "shared" })));

  const entries = [...parse(payloads[0])];
  const parents = entries.filter(({ type, values }) =>
    type === "tuple" && values.length === 2 && values.every(value => value.type === "O")
  );
  assert.equal(entries.filter(({ type }) => type === "record").length, 1);
  assert.equal(parents.length, 1);
  assert.equal(parents[0].values[0].id, parents[0].values[1].id);
  assert.equal(payloads[1], "");
});

test("a retry starts at the unchanged position after a partial write fails", async () => {
  const stores = createStores();
  const document = stores.addDocumentType("post").createDocument();
  const revision = stores.createRevision(document, {
    metadata: { timestamp: 1 },
    data: Record({ title: "Retried" }),
  });
  const failure = Error("write failed");
  const attempts = [];
  const file = {
    async write(bytes, offset, length, position) {
      attempts.push({ bytes: Buffer.from(bytes), position });
      if (attempts.length === 1) return { bytesWritten: Math.floor(length / 2) };
      if (attempts.length === 2) throw failure;
      return { bytesWritten: length };
    },
  };
  const write = createWriter(stores, file);

  await assert.rejects(write(revision), error => error === failure);
  await write(revision);

  assert.deepEqual(attempts.map(({ position }) => position), [
    0,
    Math.floor(attempts[0].bytes.length / 2),
    0,
  ]);
  assert.deepEqual(attempts[2].bytes, attempts[0].bytes);
});

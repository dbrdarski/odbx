import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DB, Record } from "../src/index.mjs";
import { parse } from "../src/parser.mjs";

const ids = revisions => revisions.map(({ id }) => id).sort();

test("create, save and reopen a document", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename);

  const document = created.addDocumentType("post").createDocument();
  const firstData = Record({ title: "Hello" });
  const firstRevision = await created.save(document, {
    metadata: { timestamp: 1 },
    data: firstData,
  });
  const secondData = Record({ title: "Hello again" });
  const secondRevision = await created.save(document, {
    metadata: { timestamp: 2, from: firstRevision.id },
    data: secondData,
  });
  await created.close();

  const db = await DB.open(filename);
  t.after(async () => {
    await db.close();
    // await rm(directory, { recursive: true, force: true });
  });
  const identity = { id: document.id };
  const thirdData = Record({ title: "Hello once more" });
  const thirdRevision = await db.save(db.latest(identity).document, {
    metadata: { timestamp: 3, from: secondRevision.id },
    data: thirdData,
  });
  const entries = [...parse(await readFile(filename))];

  assert.equal(firstRevision.document, document);
  assert.equal(firstRevision.data, firstData);
  assert.deepEqual(db.revisions(identity).map(revision => revision.id), [
    firstRevision.id,
    secondRevision.id,
    thirdRevision.id,
  ]);
  assert.equal(db.revision(firstRevision.id).data, firstData);
  assert.equal(db.revision(secondRevision.id).data, secondData);
  assert.equal(db.latest(identity), thirdRevision);
  assert.equal(db.latest(identity).data, thirdData);
  assert.equal(entries.filter(entry => entry.type === "document").length, 1);
  assert.equal(entries.filter(entry => entry.type === "revision").length, 3);
  assert.equal(entries.at(-1).type, "revision");
});

test("archive filtering and restore survive reopening", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-archive-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename);
  const posts = created.addDocumentType("post");
  const archivedDocument = posts.createDocument();
  const restoredDocument = posts.createDocument();
  const archivedInitial = await created.save(archivedDocument, {
    metadata: { timestamp: 1 },
    data: Record({ title: "Archived" }),
  });
  const archived = await created.archive(archivedDocument, { timestamp: 2 });
  const restoredInitial = await created.save(restoredDocument, {
    metadata: { timestamp: 3 },
    data: Record({ title: "Restored" }),
  });
  const beforeRestore = await created.archive(restoredDocument, { timestamp: 4 });
  const restored = await created.restore(restoredDocument, { timestamp: 5 });
  await created.close();

  const db = await DB.open(filename);
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(ids(db.latest()), [restored.id]);
  assert.deepEqual(ids(db.latest({ archived: false })), [restored.id]);
  assert.deepEqual(ids(db.latest({ archived: true })), [archived.id]);
  assert.deepEqual(ids(db.latest({ archived: null })), ids([archived, restored]));
  assert.equal(db.latest({ id: archivedDocument.id, archived: false }).id, archived.id);
  assert.equal(db.revision(archived.id).metadata.from, archivedInitial.id);
  assert.equal(db.revision(restored.id).metadata.from, beforeRestore.id);
  assert.equal(db.revision(archivedInitial.id).data, db.revision(archived.id).data);
  assert.equal(db.revision(restoredInitial.id).data, db.revision(restored.id).data);
});

test("revision ancestry is independent of chronological order", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-ancestry-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename);
  const document = created.addDocumentType("post").createDocument();
  const first = await created.save(document, {
    metadata: { timestamp: 1 },
    data: Record({ version: 1 }),
  });
  const second = await created.save(document, {
    metadata: { timestamp: 2, from: first.id },
    data: Record({ version: 2 }),
  });
  const third = await created.save(document, {
    metadata: { timestamp: 3, from: second.id },
    data: Record({ version: 3 }),
  });
  const branch = await created.save(document, {
    metadata: { timestamp: 4, from: first.id },
    data: Record({ version: 4 }),
  });
  await created.close();

  const db = await DB.open(filename);
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(db.revisions({ id: document.id }).map(({ id }) => id), [
    first.id, second.id, third.id, branch.id,
  ]);
  assert.equal(db.latest({ id: document.id }).id, branch.id);
  assert.equal(db.revision(second.id).metadata.from, first.id);
  assert.equal(db.revision(third.id).metadata.from, second.id);
  assert.equal(db.revision(branch.id).metadata.from, first.id);
});

import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DB, Record, Tuple } from "../src/index.mjs";
import { parse } from "../src/parser.mjs";

const ids = revisions => revisions.map(({ id }) => id).sort();

test("create, save and reopen a document", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename);

  const posts = created.createEntity("post");
  await assert.rejects(posts.create(Tuple()), /Document data must be a Record/);
  const firstData = Record({ title: "Hello" });
  const firstRevision = await posts.create(firstData);
  const documentId = firstRevision.document.id;
  const secondData = Record({ title: "Hello again" });
  const secondRevision = await posts.update(documentId, secondData, { from: firstRevision.id });
  await created.close();

  const db = await DB.open(filename);
  t.after(async () => {
    await db.close();
    // await rm(directory, { recursive: true, force: true });
  });
  const identity = { id: documentId };
  const thirdData = Record({ title: "Hello once more" });
  const thirdRevision = await db.createEntity("post").update(
    documentId,
    thirdData,
    { from: secondRevision.id },
  );
  const entries = [...parse(await readFile(filename))];

  assert.equal(firstRevision.document.id, documentId);
  assert.equal(firstRevision.data, firstData);
  assert.equal(firstRevision.metadata.from, null);
  assert.equal(typeof firstRevision.metadata.timestamp, "number");
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
  const posts = created.createEntity("post");
  const archivedInitial = await posts.create(Record({ title: "Initial" }));
  const archivedDocumentId = archivedInitial.document.id;
  const edit = posts.update(
    archivedDocumentId,
    Record({ title: "Archived" }),
    { from: archivedInitial.id },
  );
  const archive = posts.archive(archivedDocumentId);
  const [edited, archived] = await Promise.all([edit, archive]);
  await assert.rejects(
    posts.update(archivedDocumentId, Record({ title: "Rejected" }), { from: archived.id }),
    /Cannot update archived document/,
  );
  const restoredInitial = await posts.create(Record({ title: "Restored" }));
  const restoredDocumentId = restoredInitial.document.id;
  const archiving = posts.archive(restoredDocumentId);
  const restoring = posts.restore(restoredDocumentId);
  const [beforeRestore, restored] = await Promise.all([archiving, restoring]);
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
  assert.equal(db.latest({ id: archivedDocumentId, archived: false }).id, archived.id);
  assert.equal(db.revision(archived.id).metadata.from, edited.id);
  assert.equal(db.revision(restored.id).metadata.from, beforeRestore.id);
  assert.equal(db.revision(edited.id).data, db.revision(archived.id).data);
  assert.equal(db.revision(restoredInitial.id).data, db.revision(restored.id).data);
});

test("revision ancestry is independent of chronological order", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-ancestry-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename);
  const posts = created.createEntity("post");
  const first = await posts.create(Record({ version: 1 }));
  const documentId = first.document.id;
  const second = await posts.update(documentId, Record({ version: 2 }), { from: first.id });
  const third = await posts.update(documentId, Record({ version: 3 }), { from: second.id });
  const branch = await posts.update(documentId, Record({ version: 4 }), { from: first.id });
  await created.close();

  const db = await DB.open(filename);
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(db.revisions({ id: documentId }).map(({ id }) => id), [
    first.id, second.id, third.id, branch.id,
  ]);
  assert.equal(db.latest({ id: documentId }).id, branch.id);
  assert.equal(db.revision(second.id).metadata.from, first.id);
  assert.equal(db.revision(third.id).metadata.from, second.id);
  assert.equal(db.revision(branch.id).metadata.from, first.id);
});

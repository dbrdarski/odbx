import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Record, Tuple } from "../src/helpers.mjs";
import { createEntity, DB } from "../src/index.mjs";
import { parse } from "../src/parser.mjs";

const ids = revisions => revisions.map(({ id }) => id).sort();
const definePost = schema => ({
  post: createEntity(() => ({ relationships: {}, schema })),
});
const titleDefinitions = definePost(class Post {
  title = String;
});
const versionDefinitions = definePost(class Post {
  version = Number;
});

test("create, save and reopen a document", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename, titleDefinitions);

  const posts = created.entities.post;
  await assert.rejects(posts.create(Tuple()), /Document data must be a Record/);
  const firstData = Record({ title: "Hello" });
  const firstRevision = await posts.create(firstData);
  const documentId = firstRevision.document.id;
  const secondData = Record({ title: "Hello again" });
  const secondRevision = await posts.update(documentId, secondData, { from: firstRevision.id });
  await created.close();

  const db = await DB.open(filename, titleDefinitions);
  const reopenedPosts = db.entities.post;
  t.after(async () => {
    await db.close();
    // await rm(directory, { recursive: true, force: true });
  });
  const identity = { id: documentId };
  const thirdData = Record({ title: "Hello once more" });
  const thirdRevision = await reopenedPosts.update(
    documentId,
    thirdData,
    { from: secondRevision.id },
  );
  const entries = [...parse(await readFile(filename))];

  assert.equal(firstRevision.document.id, documentId);
  assert.equal(firstRevision.data, firstData);
  assert.equal(firstRevision.metadata.from, null);
  assert.equal(typeof firstRevision.metadata.timestamp, "number");
  assert.deepEqual(reopenedPosts.revisions(identity).map(revision => revision.id), [
    firstRevision.id,
    secondRevision.id,
    thirdRevision.id,
  ]);
  assert.equal(reopenedPosts.revision(firstRevision.id).data, firstData);
  assert.equal(reopenedPosts.revision(secondRevision.id).data, secondData);
  assert.equal(reopenedPosts.latest(identity), thirdRevision);
  assert.equal(reopenedPosts.latest(identity).data, thirdData);
  assert.equal(entries.filter(entry => entry.type === "document").length, 1);
  assert.equal(entries.filter(entry => entry.type === "revision").length, 3);
  assert.equal(entries.at(-1).type, "revision");
});

test("archive filtering and restore survive reopening", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-archive-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename, titleDefinitions);
  const posts = created.entities.post;
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

  const db = await DB.open(filename, titleDefinitions);
  const reopenedPosts = db.entities.post;
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(ids(reopenedPosts.latest()), [restored.id]);
  assert.deepEqual(ids(reopenedPosts.latest({ archived: false })), [restored.id]);
  assert.deepEqual(ids(reopenedPosts.latest({ archived: true })), [archived.id]);
  assert.deepEqual(ids(reopenedPosts.latest({ archived: null })), ids([archived, restored]));
  assert.equal(reopenedPosts.latest({ id: archivedDocumentId, archived: false }).id, archived.id);
  assert.equal(reopenedPosts.revision(archived.id).metadata.from, edited.id);
  assert.equal(reopenedPosts.revision(restored.id).metadata.from, beforeRestore.id);
  assert.equal(reopenedPosts.revision(edited.id).data, reopenedPosts.revision(archived.id).data);
  assert.equal(reopenedPosts.revision(restoredInitial.id).data, reopenedPosts.revision(restored.id).data);
});

test("revision ancestry is independent of chronological order", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-ancestry-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename, versionDefinitions);
  const posts = created.entities.post;
  const first = await posts.create(Record({ version: 1 }));
  const documentId = first.document.id;
  const second = await posts.update(documentId, Record({ version: 2 }), { from: first.id });
  const third = await posts.update(documentId, Record({ version: 3 }), { from: second.id });
  const branch = await posts.update(documentId, Record({ version: 4 }), { from: first.id });
  await created.close();

  const db = await DB.open(filename, versionDefinitions);
  const reopenedPosts = db.entities.post;
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(reopenedPosts.revisions({ id: documentId }).map(({ id }) => id), [
    first.id, second.id, third.id, branch.id,
  ]);
  assert.equal(reopenedPosts.latest({ id: documentId }).id, branch.id);
  assert.equal(reopenedPosts.revision(second.id).metadata.from, first.id);
  assert.equal(reopenedPosts.revision(third.id).metadata.from, second.id);
  assert.equal(reopenedPosts.revision(branch.id).metadata.from, first.id);
});

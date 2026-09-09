import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DB, Record } from "../src/index.mjs";
import { parse } from "../src/parser.mjs";

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

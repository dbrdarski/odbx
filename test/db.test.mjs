import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DB } from "../src/db.mjs";
import { parse } from "../src/parser.mjs";
import { Record } from "../src/values.mjs";

test("create and save a document", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-"));
  const filename = join(directory, "content.odbx");
  const db = await DB.create(filename);
  t.after(async () => {
    await db.close();
    // await rm(directory, { recursive: true, force: true });
  });

  const document = db.addDocumentType("post").createDocument();
  const firstData = Record({ title: "Hello" });
  const firstRevision = await db.save(document, {
    metadata: { timestamp: 1 },
    data: firstData,
  });
  const secondData = Record({ title: "Hello again" });
  const secondRevision = await db.save(document, {
    metadata: { timestamp: 2, from: firstRevision.id },
    data: secondData,
  });
  const entries = [...parse(await readFile(filename))];

  assert.equal(firstRevision.document, document);
  assert.equal(firstRevision.data, firstData);
  assert.equal(db.latest(document), secondRevision);
  assert.deepEqual(db.revisions(document), [firstRevision, secondRevision]);
  assert.equal(db.revision(firstRevision.id), firstRevision);
  assert.equal(db.revision(secondRevision.id), secondRevision);
  assert.equal(db.latest(document).data, secondData);
  assert.equal(entries.filter(entry => entry.type === "document").length, 1);
  assert.equal(entries.filter(entry => entry.type === "revision").length, 2);
  assert.equal(entries.at(-1).type, "revision");
});

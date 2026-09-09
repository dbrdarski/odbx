import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DB, Record } from "../src/index.mjs";
import { parse } from "../src/parser.mjs";

test("open discards an incomplete transaction", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-recovery-"));
  const filename = join(directory, "content.odbx");
  const created = await DB.create(filename);
  const document = created.addDocumentType("post").createDocument();
  const first = await created.save(document, {
    metadata: { timestamp: 1 },
    data: Record({ title: "First" }),
  });
  await created.save(document, {
    metadata: { timestamp: 2, from: first.id },
    data: Record({ title: "Incomplete" }),
  });
  await created.close();

  const complete = await readFile(filename);
  const firstEndOffset = [...parse(complete)].find(({ type }) => type === "revision").endOffset;
  await writeFile(filename, complete.subarray(0, -1));

  const recovered = await DB.open(filename);
  const identity = { id: document.id };
  assert.equal((await stat(filename)).size, firstEndOffset);
  assert.deepEqual(recovered.revisions(identity).map(({ id }) => id), [first.id]);
  const replacement = await recovered.save(recovered.latest(identity).document, {
    metadata: { timestamp: 2, from: first.id },
    data: Record({ title: "Replacement" }),
  });
  await recovered.close();

  const reopened = await DB.open(filename);
  assert.deepEqual(reopened.revisions(identity).map(({ id }) => id), [first.id, replacement.id]);
  assert.equal(reopened.latest(identity).data.title, "Replacement");
  await reopened.close();
  await rm(directory, { recursive: true, force: true });
});

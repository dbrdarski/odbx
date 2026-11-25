import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Record } from "../src/helpers.mjs";
import { createEntity, DB } from "../src/index.mjs";

const definitions = {
  post: createEntity(() => ({
    relationships: {},
    schema: class Post { title = String; },
  })),
};

test("fork paths replay only the selected state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-forks-"));
  const rootPath = join(directory, "knowledge.odbx");
  try {
    const created = await DB.create(rootPath, definitions);
    const first = await created.entities.post.create(Record({ title: "First" }));
    await created.close();

    await appendFile(rootPath, "@draft");
    await writeFile(join(directory, "knowledge.draft.odbx"), "@@@branch@");
    await writeFile(join(directory, "knowledge.draft.2.odbx"), "@leaf");
    await writeFile(join(directory, "knowledge.draft.2.leaf.odbx"), "");

    const root = await DB.open(rootPath, definitions);
    const later = await root.entities.post.update(first.document.id,
      Record({ title: "Root later" }), { from: first.id });
    const fromRoot = await root.openFork("draft", 2);
    assert.equal(fromRoot.entities.post.latest({ id: first.document.id }).id, first.id);
    await fromRoot.close();
    await root.close();

    const named = await DB.open(rootPath, definitions, ["draft"]);
    const fromNamed = await named.openFork(2);
    assert.equal(fromNamed.entities.post.latest({ id: first.document.id }).id, first.id);
    await fromNamed.close();
    await named.close();

    const target = await DB.open(rootPath, definitions, ["draft", 2]);
    const leaf = await target.openFork("leaf");
    assert.equal(leaf.entities.post.latest({ id: first.document.id }).id, first.id);
    await leaf.close();
    const targetRevision = await target.entities.post.update(first.document.id,
      Record({ title: "Target later" }), { from: first.id });
    await target.close();

    const reopenedTarget = await DB.open(rootPath, definitions, ["draft", 2]);
    assert.equal(reopenedTarget.entities.post.latest({ id: first.document.id }).id, targetRevision.id);
    await reopenedTarget.close();
    const reopenedLeaf = await DB.open(rootPath, definitions, ["draft", 2, "leaf"]);
    assert.equal(reopenedLeaf.entities.post.latest({ id: first.document.id }).id, first.id);
    await reopenedLeaf.close();
    const reopenedRoot = await DB.open(rootPath, definitions);
    assert.equal(reopenedRoot.entities.post.latest({ id: first.document.id }).id, later.id);
    await reopenedRoot.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("created forks persist independent states", async () => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-forks-"));
  const rootPath = join(directory, "knowledge.odbx");
  try {
    const root = await DB.create(rootPath, definitions);
    const pending = root.entities.post.create(Record({ title: "First" }));
    const zero = await root.fork();
    const first = await pending;
    assert.equal(zero.entities.post.latest({ id: first.document.id }).id, first.id);
    const named = await root.fork("draft");
    const one = await root.fork();
    const nested = await named.fork();

    const rootRevision = await root.entities.post.update(first.document.id,
      Record({ title: "Root" }), { from: first.id });
    const namedRevision = await named.entities.post.update(first.document.id,
      Record({ title: "Named" }), { from: first.id });
    const nestedRevision = await nested.entities.post.update(first.document.id,
      Record({ title: "Nested" }), { from: first.id });
    await nested.close();
    await named.close();
    await zero.close();
    await one.close();
    await root.close();

    const paths = [[], [0], [1], ["draft"], ["draft", 0]];
    const expected = [rootRevision.id, first.id, first.id,
      namedRevision.id, nestedRevision.id];
    for (const [index, path] of paths.entries()) {
      const reopened = await DB.open(rootPath, definitions, path);
      assert.equal(reopened.entities.post.latest({ id: first.document.id }).id,
        expected[index]);
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

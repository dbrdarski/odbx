import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createEntity,
  DB,
  Record,
  Tuple,
  UUID,
} from "../src/index.mjs"

const post = createEntity(({ belongsToMany }) => ({
  relationships: { tags: belongsToMany(tag) },
  schema: class Post {
    title = String
    tags = Tuple.of(UUID(post.tags))
  },
}))

const tag = createEntity(({ hasMany }) => ({
  relationships: { posts: hasMany(post.tags) },
  schema: class Tag {
    name = String
  },
}))

const definitions = { post, tag }

test("relationship reads follow current membership across replay", async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-relationships-"))
  const filename = join(directory, "content.odbx")
  const created = await DB.create(filename, definitions)
  const tags = created.entities.tag
  const posts = created.entities.post
  const firstTag = await tags.create(Record({ name: "First" }))
  const secondTag = await tags.create(Record({ name: "Second" }))
  const editedTag = await tags.update(
    secondTag.document.id,
    Record({ name: "Second edited" }),
    { from: secondTag.id },
  )
  const firstPost = await posts.create(Record({
    title: "Post",
    tags: Tuple(firstTag.document.id),
  }))

  assert.deepEqual(posts.tags.latest(firstPost.document.id), [firstTag])
  assert.deepEqual(tags.posts.latest(firstTag.document.id), [firstPost])

  const editedPost = await posts.update(
    firstPost.document.id,
    Record({ title: "Post", tags: Tuple(secondTag.document.id) }),
    { from: firstPost.id },
  )

  assert.deepEqual(tags.posts.latest(firstTag.document.id), [])
  assert.deepEqual(tags.posts.latest(secondTag.document.id), [editedPost])
  assert.deepEqual(
    posts.tags.revisions(firstPost.document.id).map(({ id }) => id),
    [secondTag.id, editedTag.id],
  )

  const archivedTag = await tags.archive(secondTag.document.id)

  assert.deepEqual(posts.tags.latest(firstPost.document.id), [])
  assert.deepEqual(
    posts.tags.latest(firstPost.document.id, { archived: true }),
    [archivedTag],
  )
  assert.deepEqual(
    posts.tags.latest(firstPost.document.id, { archived: null }),
    [archivedTag],
  )

  await created.close()

  const reopened = await DB.open(filename, definitions)
  t.after(async () => {
    await reopened.close()
    await rm(directory, { recursive: true, force: true })
  })

  assert.deepEqual(reopened.entities.tag.posts.latest(firstTag.document.id), [])
  assert.equal(
    reopened.entities.tag.posts.latest(secondTag.document.id)[0].id,
    editedPost.id,
  )
  assert.deepEqual(
    reopened.entities.post.tags
      .revisions(firstPost.document.id, { archived: null })
      .map(({ id }) => id),
    [secondTag.id, editedTag.id, archivedTag.id],
  )
  assert.deepEqual(reopened.entities.post.tags.latest(firstPost.document.id), [])
  assert.equal(
    reopened.entities.post.tags.latest(
      firstPost.document.id,
      { archived: true },
    )[0].id,
    archivedTag.id,
  )
})

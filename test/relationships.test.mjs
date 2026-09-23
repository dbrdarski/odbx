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
  ValidationError,
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

const profile = createEntity(({ belongsToOne }) => ({
  relationships: { user: belongsToOne(user) },
  schema: class Profile {
    user = UUID(profile.user)
  },
}))

const user = createEntity(({ hasOne }) => ({
  relationships: { profile: hasOne(profile.user) },
  schema: class User {
    name = String
  },
}))

const definitions = { post, tag, profile, user }
const missingId = "123e4567-e89b-42d3-a456-426614174000"

const createFixture = async t => {
  const directory = await mkdtemp(join(tmpdir(), "odbx-relationships-"))
  const filename = join(directory, "content.odbx")
  const databases = []
  const connect = method => method(filename, definitions).then(database =>
    (databases.push(database), database))

  t.after(async () => {
    await Promise.allSettled(databases.map(database => database.close()))
    await rm(directory, { recursive: true, force: true })
  })

  return {
    create: () => connect(DB.create),
    open: () => connect(DB.open),
  }
}

test("relationship reads follow current membership", async t => {
  const fixture = await createFixture(t)
  const { entities } = await fixture.create()
  const firstTag = await entities.tag.create(Record({ name: "First" }))
  const secondTag = await entities.tag.create(Record({ name: "Second" }))
  const editedTag = await entities.tag.update(
    secondTag.document.id,
    Record({ name: "Second edited" }),
    { from: secondTag.id },
  )
  const firstPost = await entities.post.create(Record({
    title: "Post",
    tags: Tuple(firstTag.document.id),
  }))

  assert.deepEqual(entities.post.tags.latest(firstPost.document.id), [firstTag])
  assert.deepEqual(entities.tag.posts.latest(firstTag.document.id), [firstPost])

  const editedPost = await entities.post.update(
    firstPost.document.id,
    Record({ title: "Post", tags: Tuple(secondTag.document.id) }),
    { from: firstPost.id },
  )

  assert.deepEqual(entities.tag.posts.latest(firstTag.document.id), [])
  assert.deepEqual(entities.tag.posts.latest(secondTag.document.id), [editedPost])
  assert.deepEqual(
    entities.post.tags.revisions(firstPost.document.id).map(({ id }) => id),
    [secondTag.id, editedTag.id],
  )
})

test("relationship reads apply archive filters", async t => {
  const fixture = await createFixture(t)
  const { entities } = await fixture.create()
  const tagRevision = await entities.tag.create(Record({ name: "Tag" }))
  const postRevision = await entities.post.create(Record({
    title: "Post",
    tags: Tuple(tagRevision.document.id),
  }))
  const archivedTag = await entities.tag.archive(tagRevision.document.id)

  assert.deepEqual(entities.post.tags.latest(postRevision.document.id), [])
  assert.deepEqual(
    entities.post.tags.latest(postRevision.document.id, { archived: true }),
    [archivedTag],
  )
  assert.deepEqual(
    entities.post.tags.latest(postRevision.document.id, { archived: null }),
    [archivedTag],
  )
})

test("relationship reads survive replay", async t => {
  const fixture = await createFixture(t)
  const created = await fixture.create()
  const tagRevision = await created.entities.tag.create(Record({ name: "Tag" }))
  const editedTag = await created.entities.tag.update(
    tagRevision.document.id,
    Record({ name: "Tag edited" }),
    { from: tagRevision.id },
  )
  const postRevision = await created.entities.post.create(Record({
    title: "Post",
    tags: Tuple(tagRevision.document.id),
  }))
  const archivedTag = await created.entities.tag.archive(tagRevision.document.id)
  await created.close()

  const reopened = await fixture.open()

  assert.deepEqual(
    reopened.entities.tag.posts
      .latest(tagRevision.document.id)
      .map(({ id }) => id),
    [postRevision.id],
  )
  assert.deepEqual(
    reopened.entities.post.tags
      .revisions(postRevision.document.id, { archived: null })
      .map(({ id }) => id),
    [tagRevision.id, editedTag.id, archivedTag.id],
  )
  assert.deepEqual(
    reopened.entities.post.tags.latest(postRevision.document.id),
    [],
  )
  assert.deepEqual(
    reopened.entities.post.tags
      .latest(postRevision.document.id, { archived: true })
      .map(({ id }) => id),
    [archivedTag.id],
  )
})

test("to-one relationship reads return one revision or null", async t => {
  const fixture = await createFixture(t)
  const { entities } = await fixture.create()
  const userRevision = await entities.user.create(Record({ name: "User" }))
  const profileRevision = await entities.profile.create(Record({
    user: userRevision.document.id,
  }))

  assert.equal(
    entities.profile.user.latest(profileRevision.document.id),
    userRevision,
  )
  assert.equal(
    entities.user.profile.latest(userRevision.document.id),
    profileRevision,
  )
  assert.equal(entities.profile.user.latest(missingId), null)
  assert.equal(entities.user.profile.latest(missingId), null)
})

test("missing relationship targets reject without persistence", async t => {
  const fixture = await createFixture(t)
  const created = await fixture.create()

  await assert.rejects(
    created.entities.profile.create(Record({ user: missingId })),
    ValidationError,
  )
  assert.deepEqual(created.entities.profile.latest(), [])
  await created.close()

  const reopened = await fixture.open()
  assert.deepEqual(reopened.entities.profile.latest(), [])
})

test("hasOne rejects a second source document", async t => {
  const fixture = await createFixture(t)
  const { entities } = await fixture.create()
  const userRevision = await entities.user.create(Record({ name: "User" }))
  const data = Record({ user: userRevision.document.id })
  const profileRevision = await entities.profile.create(data)

  await assert.rejects(entities.profile.create(data), ValidationError)
  assert.deepEqual(entities.profile.latest(), [profileRevision])
})

test("an archived source retains its hasOne slot", async t => {
  const fixture = await createFixture(t)
  const { entities } = await fixture.create()
  const userRevision = await entities.user.create(Record({ name: "User" }))
  const data = Record({ user: userRevision.document.id })
  const profileRevision = await entities.profile.create(data)
  const archivedProfile = await entities.profile.archive(profileRevision.document.id)

  await assert.rejects(entities.profile.create(data), ValidationError)
  assert.equal(entities.user.profile.latest(userRevision.document.id), null)
  assert.equal(
    entities.user.profile.latest(userRevision.document.id, { archived: true }),
    archivedProfile,
  )
})

test("replay preserves hasOne uniqueness", async t => {
  const fixture = await createFixture(t)
  const created = await fixture.create()
  const userRevision = await created.entities.user.create(Record({ name: "User" }))
  const data = Record({ user: userRevision.document.id })
  const profileRevision = await created.entities.profile.create(data)
  await created.close()

  const reopened = await fixture.open()

  assert.equal(
    reopened.entities.user.profile.latest(userRevision.document.id).id,
    profileRevision.id,
  )
  await assert.rejects(reopened.entities.profile.create(data), ValidationError)
})

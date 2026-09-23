import assert from "node:assert/strict"
import test from "node:test"
import {
  createEntity,
  Record,
  UUID,
  Union,
  validate,
  ValidationError,
} from "../src/index.mjs"

const firstId = "123e4567-e89b-42d3-a456-426614174000"
const secondId = "123e4567-e89b-42d3-a456-426614174001"

const target = createEntity(() => ({
  relationships: {},
  schema: null,
}))

const source = createEntity(({ belongsToOne }) => ({
  relationships: { target: belongsToOne(target) },
  schema: null,
}))

const relationship = source.target

class Links {
  first = UUID(relationship)
  second = UUID(relationship)
}

const errors = result =>
  Array.from(result.errors, ({ code, path }) => ({
    code,
    path: Array.from(path),
  }))

test("relationship UUIDs reject invalid UUIDs before reference validation", () => {
  const [result] = validate(
    UUID(relationship),
    "123e4567-e89b-12d3-a456-426614174000",
    () => assert.fail("invalid UUID reached reference validation"),
  )

  assert(result instanceof ValidationError)
  assert.deepEqual(errors(result), [
    { code: "type", path: [] },
  ])
})

test("relationship UUIDs reject missing references", () => {
  const [result] = validate(UUID(relationship), firstId, () => false)

  assert(result instanceof ValidationError)
  assert.deepEqual(errors(result), [
    { code: "relationship", path: [] },
  ])
})

test("belongsToOne rejects multiple target IDs", () => {
  const [result, relations] = validate(
    Links,
    Record({ first: firstId, second: secondId }),
    () => true,
  )

  assert(result instanceof ValidationError)
  assert.deepEqual(errors(result), [
    { code: "relationship", path: ["first"] },
    { code: "relationship", path: ["second"] },
  ])
  assert.deepEqual(
    Array.from(result.errors, ({ id }) => id),
    [firstId, secondId],
  )
  assert.deepEqual(
    Array.from(relations.get(relationship)),
    [firstId, secondId],
  )
})

test("Union discards relationships from failed alternatives", () => {
  const [result, relations] = validate(
    Union(UUID(relationship), String),
    firstId,
    () => false,
  )

  assert.equal(result, true)
  assert.equal(relations.size, 0)
})

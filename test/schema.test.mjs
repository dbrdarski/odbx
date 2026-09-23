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
const wrongVersion = "123e4567-e89b-12d3-a456-426614174000"

const target = createEntity(() => ({
  relationships: {},
  schema: null,
}))

const source = createEntity(({ belongsToOne }) => ({
  relationships: {
    target: belongsToOne(target),
  },
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

test("relationship schemas validate UUIDs, references, cardinality, and Union alternatives", () => {
  const [invalidUuid] = validate(
    UUID(relationship),
    wrongVersion,
    () => assert.fail("invalid UUID reached reference validation"),
  )
  assert(invalidUuid instanceof ValidationError)
  assert.deepEqual(errors(invalidUuid), [
    { code: "type", path: [] },
  ])

  const [missingReference] = validate(
    UUID(relationship),
    firstId,
    () => false,
  )
  assert(missingReference instanceof ValidationError)
  assert.deepEqual(errors(missingReference), [
    { code: "relationship", path: [] },
  ])

  const [invalidCardinality, relations] = validate(
    Links,
    Record({
      first: firstId,
      second: secondId,
    }),
    () => true,
  )
  assert(invalidCardinality instanceof ValidationError)
  assert.deepEqual(errors(invalidCardinality), [
    { code: "relationship", path: ["first"] },
    { code: "relationship", path: ["second"] },
  ])
  assert.deepEqual(
    Array.from(invalidCardinality.errors, ({ id }) => id),
    [firstId, secondId],
  )
  assert.deepEqual(
    Array.from(relations.get(relationship)),
    [firstId, secondId],
  )

  const [validUnion, unionRelations] = validate(
    Union(UUID(relationship), String),
    firstId,
    () => false,
  )
  assert.equal(validUnion, true)
  assert.equal(unionRelations.size, 0)
})

import assert from "node:assert/strict"
import test from "node:test"
import { Record, Tuple } from "../src/helpers.mjs"
import {
  createEntity,
  Schema,
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

const issues = result =>
  Array.from(result.errors, issue => ({
    ...issue,
    path: Array.from(issue.path),
  }))

for (const [name, schema, valid, invalid, received] of [
  ["String", String, ["", "value"], 1, "Number"],
  ["Number", Number, [0, NaN, Infinity], "1", "String"],
  ["Boolean", Boolean, [true, false], 0, "Number"],
  ["null", null, [null], false, "Boolean"],
]) test(`${name} validates its primitive type`, () => {
  valid.forEach(value => assert.equal(validate(schema, value)[0], true))

  const [result] = validate(schema, invalid)

  assert.deepEqual(issues(result), [{
    code: "type",
    expected: name,
    path: [],
    received,
  }])
})

test("plain objects and arrays are not schemas", () => {
  assert.throws(() => Schema({}), /Invalid schema/)
  assert.throws(() => Schema([]), /Invalid schema/)
})

class Person {
  active = Boolean
  name = String
}

test("class schemas validate Records", () => {
  assert.equal(
    validate(Person, Record({ active: true, name: "Ada" }))[0],
    true,
  )
  assert.equal(Schema(Person).name, "Person")

  const [result] = validate(Person, { active: true, name: "Ada" })

  assert.deepEqual(issues(result), [{
    code: "type",
    expected: "Record",
    path: [],
    received: "Object",
  }])
})

test("class schemas collect invalid, missing, and unexpected fields", () => {
  const [result] = validate(Person, Record({ active: "yes", extra: null }))

  assert(result instanceof ValidationError)
  assert(result.errors instanceof Tuple)
  assert(result.errors.every(issue => issue instanceof Record))
  assert(result.errors.every(issue => issue.path instanceof Tuple))
  assert.deepEqual(issues(result), [
    {
      code: "type",
      expected: "Boolean",
      path: ["active"],
      received: "String",
    },
    {
      code: "missing",
      expected: "String",
      path: ["name"],
    },
    {
      code: "unexpected",
      path: ["extra"],
      received: "null",
    },
  ])
})

test("null composes as a class field schema", () => {
  class Nullable {
    value = null
  }

  assert.equal(validate(Nullable, Record({ value: null }))[0], true)

  const [invalid] = validate(Nullable, Record({ value: false }))
  assert.deepEqual(issues(invalid), [{
    code: "type",
    expected: "null",
    path: ["value"],
    received: "Boolean",
  }])

  const [result] = validate(Nullable, Record())

  assert.deepEqual(issues(result), [{
    code: "missing",
    expected: "null",
    path: ["value"],
  }])
})

test("fixed Tuple schemas validate every position", () => {
  const schema = Tuple(String, Number)

  assert.equal(Schema(schema).name, "[String, Number]")
  assert.equal(validate(schema, Tuple("value", 1))[0], true)

  const [short] = validate(schema, Tuple(false))
  assert.deepEqual(issues(short), [
    {
      code: "type",
      expected: "String",
      path: [0],
      received: "Boolean",
    },
    {
      code: "missing",
      expected: "Number",
      path: [1],
    },
  ])

  const [long] = validate(schema, Tuple("value", 1, true))
  assert.deepEqual(issues(long), [{
    code: "unexpected",
    path: [2],
    received: "Boolean",
  }])

  const [array] = validate(schema, ["value", 1])
  assert.deepEqual(issues(array), [{
    code: "type",
    expected: "Tuple",
    path: [],
    received: "Array",
  }])
})

test("null composes inside a fixed Tuple schema", () => {
  const schema = Tuple(null)

  assert.equal(Schema(schema).name, "[null]")
  assert.equal(validate(schema, Tuple(null))[0], true)
})

test("Tuple.of validates every item", () => {
  const schema = Tuple.of(String)

  assert.equal(schema.name, "String[]")
  assert.equal(validate(schema, Tuple())[0], true)
  assert.equal(validate(schema, Tuple("first", "second"))[0], true)

  const [result] = validate(schema, Tuple(1, "valid", false))
  assert.deepEqual(issues(result), [
    {
      code: "type",
      expected: "String",
      path: [0],
      received: "Number",
    },
    {
      code: "type",
      expected: "String",
      path: [2],
      received: "Boolean",
    },
  ])

  const [array] = validate(schema, ["value"])
  assert.deepEqual(issues(array), [{
    code: "type",
    expected: "Tuple",
    path: [],
    received: "Array",
  }])
})

test("null composes inside Tuple.of", () => {
  const schema = Tuple.of(null)

  assert.equal(schema.name, "null[]")
  assert.equal(validate(schema, Tuple(null, null))[0], true)
})

test("composite schemas retain their validator names", () => {
  const pair = Tuple(String, Number)

  assert.equal(Schema(Tuple(pair)).name, "[[String, Number]]")
  assert.equal(Tuple.of(pair).name, "[String, Number][]")

  class Container {
    pair = pair
  }

  const [result] = validate(Container, Record())
  assert.deepEqual(issues(result), [{
    code: "missing",
    expected: "[String, Number]",
    path: ["pair"],
  }])
})

test("Union accepts either alternative and reports its complete name", () => {
  const schema = Union(String, Number)

  assert.equal(schema.name, "String | Number")
  assert.equal(validate(schema, "value")[0], true)
  assert.equal(validate(schema, 1)[0], true)

  const [result] = validate(schema, false)
  assert.deepEqual(issues(result), [{
    code: "type",
    expected: "String | Number",
    path: [],
    received: "Boolean",
  }])

  const nullable = Union(null, String)
  assert.equal(nullable.name, "null | String")
  assert.equal(validate(nullable, null)[0], true)
})

test("recursive class schemas resolve through the cached validator", () => {
  class Node {
    label = String
    children = Tuple.of(Node)
  }

  const value = Record({
    label: "root",
    children: Tuple(
      Record({ label: "child", children: Tuple() }),
    ),
  })

  assert.equal(validate(Node, value)[0], true)

  const [result] = validate(Node, Record({
    label: "root",
    children: Tuple(Record({ label: false, children: Tuple() })),
  }))
  assert.deepEqual(issues(result), [{
    code: "type",
    expected: "String",
    path: ["children", 0, "label"],
    received: "Boolean",
  }])
})

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

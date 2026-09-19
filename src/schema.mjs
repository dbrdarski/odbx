import { Tuple } from "./values.mjs"

const primitive = type => value => typeof value === type

const nullValidator = value => value === null

const resolvedValidators = new Map([
  [String, primitive("string")],
  [Boolean, primitive("boolean")],
  [Number, primitive("number")],
  [null, nullValidator],
])

const isClass = value =>
  typeof value === "function" &&
  /^\s*class\s+/.test(value.toString())

const resolveValidator = value => {
  if (value instanceof Tuple)
    return createTupleValidator(value)

  if (isClass(value))
    return createClassValidator(value)

  if (typeof value === "function")
    return value

  throw new TypeError("Invalid schema")
}

export const Schema = value => resolvedValidators.get(value)
  ?? resolvedValidators
    .set(value, resolveValidator(value))
    .get(value)

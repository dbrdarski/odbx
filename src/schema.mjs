import { Record, Tuple } from "./values.mjs"

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

const createTupleValidator = validator => (value, run) => {
  if (!(value instanceof Tuple))
    return typeMismatch(run, Tuple, value)

  return (validator.length > value.length ? validator : value)
    .reduce((valid, _, index) => {
      const branch = run.branch(index)

      if (index >= validator.length)
        return branch.collect(
          unexpected(branch, value[index])
        )

      if (index >= value.length)
        return branch.collect(
          missing(branch, validator[index])
        )

      return branch.collect(
        Schema(validator[index])(value[index], branch)
      ) && valid
    }, true)
}

Tuple.of = validator => (value, run) => {
  if (!(value instanceof Tuple))
    return typeMismatch(run, Tuple, value)

  return value.reduce((valid, item, index) => {
    const branch = run.branch(index)

    return branch.collect(
      Schema(validator)(item, branch)
    ) && valid
  }, true)
}

const createClassValidator = validator => {
  const definition = Record(new validator())

  return (value, run) => {
    if (!(value instanceof Record))
      return typeMismatch(run, Record, value)

    return Array.from(new Set([
      ...Record.keys(definition),
      ...Record.keys(value),
    ])).reduce((valid, key) => {
      const branch = run.branch(key)

      if (!Object.hasOwn(definition, key))
        return branch.collect(
          unexpected(branch, value[key])
        )

      if (!Object.hasOwn(value, key))
        return branch.collect(
          missing(branch, definition[key])
        )

      return branch.collect(
        Schema(definition[key])(value[key], branch)
      ) && valid
    }, true)
  }
}

const resolveValidator = validator => {
  if (validator instanceof Tuple)
    return createTupleValidator(validator)

  if (isClass(validator))
    return createClassValidator(validator)

  if (typeof validator === "function")
    return validator

  throw new TypeError("Invalid schema")
}

export const Schema = value => resolvedValidators.get(value)
  ?? resolvedValidators
    .set(value, resolveValidator(value))
    .get(value)

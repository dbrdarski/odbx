import { Record, Tuple } from "./values.mjs"

const named = (name, validator) =>
  Object.defineProperty(validator, "name", { value: name })

const primitive = (constructor, type = typeof constructor()) => [
  constructor,
  named(constructor.name, value => typeof value === type),
]

const nullValidator = value => value === null

const resolvedValidators = new Map([
  primitive(String),
  primitive(Boolean),
  primitive(Number),
  [null, named("null", nullValidator)],
])

const isClass = value =>
  typeof value === "function" &&
  /^\s*class\s+/.test(value.toString())

const describe = value =>
  value?.constructor?.name ?? String(value)

const validationError = (code, run, details) =>
  Record({ code, path: run.path, ...details })

const typeMismatch = (run, expected, received) =>
  validationError("type", run, {
    expected: expected.name,
    received: describe(received),
  })

const missing = (run, expected) =>
  validationError("missing", run, {
    expected: expected.name,
  })

const unexpected = (run, received) =>
  validationError("unexpected", run, {
    received: describe(received),
  })

const tupleName = validators =>
  `[${Array.from(validators, validator => validator.name).join(", ")}]`

const createTupleValidator = validator => named(
  tupleName(validator),
  (value, run) => {
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
)

Tuple.of = validator => named(
  `${validator.name}[]`,
  (value, run) => {
    if (!(value instanceof Tuple))
      return typeMismatch(run, Tuple, value)

    return value.reduce((valid, item, index) => {
      const branch = run.branch(index)

      return branch.collect(
        Schema(validator)(item, branch)
      ) && valid
    }, true)
  }
)

const createClassValidator = validator => {
  const definition = Record(new validator())

  return named(validator.name, (value, run) => {
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
  })
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

export class ValidationError extends Error {
  constructor(errors) {
    super()
    this.errors = Tuple(...errors)
  }
}

const createValidationRun = (
  path = Tuple(),
  errors = [],
  relationsMap = new Map()
) => ({
  path,
  errors,
  relationsMap,

  branch: key =>
    createValidationRun(
      Tuple(...path, key),
      errors,
      relationsMap
    ),

  collect: result => typeof result === "boolean"
    ? result
    : (errors.push(result), false),
})

export const validate = (schema, value) => {
  const run = createValidationRun()

  run.collect(
    Schema(schema)(value, run)
  )

  return [
    run.errors.length
      ? new ValidationError(run.errors)
      : true,
    run.relationsMap,
  ]
}

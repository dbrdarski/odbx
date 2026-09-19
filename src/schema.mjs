import { Record, Tuple } from "./values.mjs"

const named = (name, validator) =>
  Object.defineProperty(validator, "name", { value: name })

const withError = (errorType, predicate) => {
  const validator = (value, run) =>
    predicate(value) ||
    errorType(run, validator, value)

  return validator
}

const primitive = (constructor, type = typeof constructor()) => [
  constructor,
  named(
    constructor.name,
    withError(
      typeMismatch,
      value => typeof value === type
    )
  ),
]

const nullValidator = value => value === null

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

const resolvedValidators = new Map([
  primitive(String),
  primitive(Boolean),
  primitive(Number),
  [
    null,
    named(
      "null",
      withError(typeMismatch, nullValidator)
    ),
  ],
])

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

const mergeRelations = (target, source) =>
  source.forEach((values, relation) =>
    target.set(relation, new Set([
      ...(target.get(relation) ?? []),
      ...values,
    ])))

const validateAlternative = (schema, value, run) => {
  const alternative = createValidationRun(run.path)
  const valid = alternative.collect(
    Schema(schema)(value, alternative)
  )

  if (valid)
    mergeRelations(run.relationsMap, alternative.relationsMap)

  return valid
}

const validatorName = validator =>
  validator?.name || Schema(validator).name

export const Union = (left, right) => {
  const validator = named(
    `${validatorName(left)} | ${validatorName(right)}`,
    (value, run) =>
      validateAlternative(left, value, run) ||
      validateAlternative(right, value, run) ||
      typeMismatch(run, validator, value)
  )

  return validator
}

export const UUID = relationship => {
  const validator = named("UUID", (id, run) => {
    if (typeof id !== "string")
      return typeMismatch(run, validator, id)

    const ids = run.relationsMap.get(relationship) ?? new Set()
    ids.add(id)
    run.relationsMap.set(relationship, ids)

    return true
  })

  return validator
}

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

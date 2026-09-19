const primitive = type => value => typeof value === type

const nullValidator = value => value === null

const resolvedValidators = new Map([
  [String, primitive("string")],
  [Boolean, primitive("boolean")],
  [Number, primitive("number")],
  [null, nullValidator],
])

export const Schema = shape => resolvedValidators.get(shape)

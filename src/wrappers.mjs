import { Record, Tuple } from './values.mjs'

const isPlainObject = value =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))

export const fromJS = value =>
  value === undefined ? null :
  value instanceof Record || value instanceof Tuple ? value :
  Array.isArray(value) ? Tuple(...value.map(fromJS)) :
  isPlainObject(value)
    ? Record.from(Object.keys(value), Object.values(value).map(fromJS))
    : value

export const encodeJSON = value =>
  JSON.stringify(value, (_, value) => value === undefined ? null : value)

export const decodeJSON = source =>
  JSON.parse(source, (_, value) =>
    Array.isArray(value)
      ? Tuple(...value)
      : value !== null && typeof value === 'object'
        ? Record(value)
        : value)

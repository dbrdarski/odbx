import { Record, Tuple } from "./values.mjs"

export const once = (fn, result, resolved) => () =>
  resolved ? result : (resolved = true, result = fn())

export const deepClone = value => {
  if (value === null || typeof value !== "object" ||
      value instanceof Tuple || value instanceof Record) return value;
  if (value instanceof Map)
    return new Map(Array.from(value, ([key, item]) => [key, deepClone(item)]));
  if (value instanceof Set)
    return new Set(Array.from(value, deepClone));
  if (Array.isArray(value))
    return value.map(deepClone);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, deepClone(item)])
  );
}

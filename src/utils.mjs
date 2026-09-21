export const once = (fn, result, resolved) => () =>
  resolved ? result : (resolved = true, result = fn())

import { once } from "./utils.mjs"

const relation = (kind, source, target) =>
  Object.freeze({ kind, source, target })

const relationships = source => ({
  belongsToOne: target => relation("belongsToOne", source, target),
  belongsToMany: target => relation("belongsToMany", source, target),
  hasOne: target => relation("hasOne", source, target),
  hasMany: target => relation("hasMany", source, target),
})

export const createEntity = factory => {
  const entity = new Proxy(
    once(() => factory(relationships(entity))),
    {
      get: (resolve, property) =>
        resolve().relationships[property],
    },
  )

  return entity
}

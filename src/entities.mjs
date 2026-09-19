const definition = Symbol()

const relation = (kind, source, target) =>
  Object.freeze({ kind, source, target })

const relationships = source => ({
  belongsToOne: target => relation("belongsToOne", source, target),
  belongsToMany: target => relation("belongsToMany", source, target),
  hasOne: target => relation("hasOne", source, target),
  hasMany: target => relation("hasMany", source, target),
})

export const resolveEntity = entity => entity[definition]

export const createEntity = factory => {
  const state = {}
  const target = Object.create(null)
  const entity = new Proxy(target, {
    get: (target, property) => {
      if (!state.definition) {
        const value = factory(relationships(entity))
        Object.assign(target, value.relationships)
        Object.freeze(target)
        state.definition = value
      }

      return property === definition
        ? state.definition
        : target[property]
    },
  })

  return entity
}

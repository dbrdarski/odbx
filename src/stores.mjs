import { encodeInt, encodePrimitive, encodeString } from './codec.mjs';
import { stringReference, tupleReference, recordReference, entityReference, revisionReference } from './symbols.mjs';
import { Record, Tuple } from './values.mjs';

const createCounter = (value = 0) => ({
  fork: () => createCounter(value),
  getId: () => value++,
});

export const createStore = ({ reference, serialize }, counter = createCounter(0), keys = new Map()) => ({
  transact: () => {
    const prev = counter
    counter = counter.fork()
    return (entries) => {
      for (const entry of entries) {
        keys.delete(entry)
      }
      counter = prev
    }
  },
  getKey(write, value) {
    const existing = keys.get(value);
    if (existing != null) return existing;
    // Serialization discovers children before allocating the parent ID.
    const definition = serialize(write, value);
    const key = reference(counter.getId(), write);
    keys.set(value, key);
    write(definition);
    return key;
  }
})

export function createStores() {
  const getKey = (write, value) => {
    if (typeof value === 'string') return stringStore.getKey(write, value);
    if (value instanceof Tuple) return tupleStore.getKey(write, value);
    if (value instanceof Record) return recordStore.getKey(write, value);
    return encodePrimitive(value);
  };
  const stringStore = createStore({
    reference: stringReference,
    serialize: (_, value) => encodeString(value)
  });
  const entityStore = createStore({
    reference: entityReference,
    serialize: (write, name) => `<${stringStore.getKey(write, name)}>`
  });
  const tupleStore = createStore({
    reference: tupleReference,
    serialize: (write, value) => `[${Array.from(value, child => getKey(write, child)).join('')}]`,
  });
  const recordStore = createStore({
    reference: recordReference,
    serialize: (write, value) => `{${getKey(write, Record.keys(value))}${getKey(write, Record.values(value))}}`,
  });
  const createDocumentStore = name => createStore({
    reference: (id, write) => `D${encodeInt(id)}${entityStore.getKey(write, name)}`,
    serialize: write => `<${entityStore.getKey(write, name)}>`,
  });
  const createRevisionStore = document => createStore({
    reference: revisionReference,
    serialize: (write, { metadata, data, archived }) =>
      `(${document}${getKey(write, metadata)}${getKey(write, data)}${encodePrimitive(archived)})`,
  });
  const documentTypes = Object.create(null);
  const addDocumentType = name => {
    if (documentTypes[name]) throw Error(`Duplicate document type: ${name}`);
    return documentTypes[name] = {
      documentStore: createDocumentStore(name),
      createRevisionStore,
    };
  };
  return { stringStore, tupleStore, recordStore, entityStore, addDocumentType, getKey };
}

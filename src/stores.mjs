import { encodePrimitive, encodeString } from './codec.mjs';
import { stringReference, tupleReference, recordReference, documentReference, revisionReference } from './symbols.mjs';
import { Record, Tuple } from './values.mjs';

const createCounter = value => ({
  fork: () => createCounter(value),
  getId: () => value++,
});

export function createStore({ reference, serialize }, counter = 0n, keys = new Map()) {
  const store = {
    counter: createCounter(counter),
    getKey(write, value) {
      const existing = keys.get(value);
      if (existing != null) return existing;
      // Serialization discovers children before allocating the parent ID.
      const definition = serialize(write, value);
      const key = reference(store.counter.getId());
      keys.set(value, key);
      write(definition);
      return key;
    },
  };
  return store;
}

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
  const tupleStore = createStore({
    reference: tupleReference,
    serialize: (write, value) => `[${Array.from(value, child => getKey(write, child)).join('')}]`,
  });
  const recordStore = createStore({
    reference: recordReference,
    serialize: (write, value) => `{${getKey(write, Tuple(...Object.keys(value)))}${getKey(write, Tuple(...Object.values(value)))}}`,
  });
  const createDocumentStore = type => createStore({
    reference: documentReference(type),
    serialize: (write, document) => `<${getKey(write, document.type)}>`,
  });
  const createRevisionStore = type => documentId => createStore({
    reference: revisionReference,
    serialize: (write, { metadata, data, archived }) =>
      `(${documentReference(type)(documentId)}${getKey(write, metadata)}${getKey(write, data)}${encodePrimitive(archived)})`,
  });
  return { stringStore, tupleStore, recordStore, createDocumentStore, createRevisionStore, getKey };
}

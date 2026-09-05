import { encodePrimitive, encodeString } from './codec.mjs';
import { stringReference, tupleReference, recordReference } from './symbols.mjs';
import { Record, Tuple } from './values.mjs';

const createCounter = value => ({
  fork: () => createCounter(value),
  getId: () => value++,
});

export function createStore({ reference, serialize }) {
  return (counter = 0n, keys = new Map()) => {
    const store = {
      counter: createCounter(counter),
      getKey(write, value) {
        const existing = keys.get(value);
        if (existing !== undefined) return existing;
        // Serialization discovers children before allocating the parent ID.
        const definition = serialize(write, value);
        const key = reference(write.counters.get(store).getId());
        keys.set(value, key);
        write.created.push([keys, value]);
        write.output.push(definition);
        return key;
      },
    };
    return store;
  };
}

export const createStringStore = createStore({
  reference: stringReference,
  serialize: (_write, value) => encodeString(value),
});

export const createTupleStore = createStore({
  reference: tupleReference,
  // Use an ordinary Array; Oddo's inherited Array methods use its constructor.
  serialize: (write, value) => `[${Array.from(value, child => getKey(write, child)).join('')}]`,
});

export const createRecordStore = createStore({
  reference: recordReference,
  serialize: (write, value) => {
    const keys = getKey(write, Tuple(...Object.keys(value)));
    const values = getKey(write, Tuple(...Object.values(value)));
    return `{${keys}${values}}`;
  },
});

export function getKey(write, value) {
  if (typeof value === 'string') return write.stringStore.getKey(write, value);
  if (value instanceof Tuple) return write.tupleStore.getKey(write, value);
  if (value instanceof Record) return write.recordStore.getKey(write, value);
  return encodePrimitive(value);
}

export function rollback(created) {
  for (let i = created.length - 1; i >= 0; i--) {
    const [keys, value] = created[i];
    keys.delete(value);
  }
  created.length = 0;
}

import { encodePrimitive, encodeString } from "./codec.mjs";
import { stringReference, tupleReference, recordReference, documentReference, revisionReference } from "./symbols.mjs";
import { Record, Tuple } from "./values.mjs";

const randomHash = () => crypto.randomUUID();
const bind = (fn, ...args) => fn.bind(null, ...args)

const createCounter = (value = 0) => ({
  fork: () => createCounter(value),
  getId: () => value++,
});

export const createStore = ({ reference, serialize }, counter = createCounter(0), keys = new Map()) => ({
  transact: () => {
    const prev = counter
    counter = counter.fork()
    return () => counter = prev
  },
  getKey(write, value) {
    const existing = keys.get(value);
    if (existing != null) return existing;
    // Serialization discovers children before allocating the parent ID.
    const definition = serialize(write, value);
    const key = reference(counter.getId());
    keys.set(value, key);
    write(definition, value, keys);
    return key;
  }
})

export function createStores() {
  const getKey = (write, value) => {
    if (typeof value === "string") return stringStore.getKey(write, value);
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
    serialize: (write, value) => `[${Array.from(value, bind(getKey, write)).join("")}]`,
  });
  const recordStore = createStore({
    reference: recordReference,
    serialize: (write, value) => `{${getKey(write, Record.keys(value))}${getKey(write, Record.values(value))}}`,
  });
  const documentStore = createStore({
    reference: documentReference,
    serialize: (write, { id, type }) =>
      `<${stringStore.getKey(write, id)}${stringStore.getKey(write, type)}>`,
  });
  const revisionStore = createStore({
    reference: revisionReference,
    serialize: (write, { document, metadata, data, archived }) =>
      `(${documentStore.getKey(write, document)}${getKey(write, metadata)}${getKey(write, data)}${encodePrimitive(archived)})`,
  });
  const documentTypes = Object.create(null);
  const addDocumentType = name => {
    if (documentTypes[name]) throw Error(`Duplicate document type: ${name}`);
    return documentTypes[name] = {
      createDocument: () => Record({ id: randomHash(), type: name }),
    };
  };
  const createRevision = (document, { metadata, data, archived = false }) => {
    const id = randomHash();
    return { id, document, metadata: Record({ ...metadata, id, archived }), data, archived };
  };
  return { stringStore, tupleStore, recordStore, documentStore, revisionStore, addDocumentType, createRevision, getKey };
}

import { encodePrimitive, encodeString } from "./codec.mjs";
import { stringReference, tupleReference, recordReference, documentReference, revisionReference } from "./symbols.mjs";
import { Record, Tuple } from "./values.mjs";

const randomHash = () => crypto.randomUUID();
const bind = (fn, ...args) => fn.bind(null, ...args)
const createMatch = (values = []) => ({
  write: (_, value) => values.push(value),
  read: id => values[id],
})

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

  const matchTokens = tokens => {
    const match = {
      string: createMatch(),
      tuple: createMatch(),
      record: createMatch(),
      document: createMatch(),
      revision: createMatch(),
    }
    for (const token of tokens) matchToken(match)(token)
  }
  const matchToken = match => token => {
    switch (token.type) {
      case "primitive": return token.value;
      case "S": return match.string.read(token.id);
      case "A": return match.tuple.read(token.id);
      case "O": return match.record.read(token.id);
      case "D": return match.document.read(token.id);
      case "R": return match.revision.read(token.id);
      case "string": return void stringStore.getKey(match.string.write, token.value);
      case "tuple": return void tupleStore.getKey(match.tuple.write, Tuple(...token.values.map(matchToken(match))));
      case "record": return void recordStore.getKey(match.record.write, Record.from(
        matchToken(match)(token.keys),
        matchToken(match)(token.values),
      ))
      case "document": return void documentStore.getKey(match.document.write, Record({
        id: matchToken(match)(token.id),
        type: matchToken(match)(token.documentType),
      }));
      case "revision": {
        const metadata = matchToken(match)(token.metadata)
        return void revisionStore.getKey(match.revision.write, {
          id: metadata.id,
          document: matchToken(match)(token.document),
          metadata,
          data: matchToken(match)(token.data),
          archived: matchToken(match)(token.archived),
        });
      }
    }
  }

  return { stringStore, tupleStore, recordStore, documentStore, revisionStore, addDocumentType, createRevision, getKey, matchTokens };
}

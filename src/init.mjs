import { createStringStore, createTupleStore, createRecordStore } from './stores.mjs';

export function init(stores = {
  stringStore: createStringStore(),
  tupleStore: createTupleStore(),
  recordStore: createRecordStore(),
}) {
  return {
    ...stores,
    counters: new Map(Object.values(stores).map(store => [store, store.counter.fork()])),
    output: [],
    created: [],
  };
}

import { createStringStore, createTupleStore, createRecordStore } from './stores.mjs';

export function init() {
  return {
    stringStore: createStringStore(),
    tupleStore: createTupleStore(),
    recordStore: createRecordStore(),
  };
}

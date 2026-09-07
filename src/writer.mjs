import { createCommit } from "./commit.mjs";
import { persist } from "./persist.mjs";

export function createWriter(stores, file) {
  const { stringStore, tupleStore, recordStore, documentStore, revisionStore } = stores;
  const commit = createCommit(
    [stringStore, tupleStore, recordStore, documentStore, revisionStore],
    payload => persist(file, payload),
  );
  return revision => commit(write => revisionStore.getKey(write, revision));
}

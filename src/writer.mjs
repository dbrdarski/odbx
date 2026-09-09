import { createCommit } from "./commit.mjs";
import { persist } from "./persist.mjs";

export function createWriter(stores, file, position = 0) {
  const { stringStore, tupleStore, recordStore, documentStore, revisionStore } = stores;
  const commit = createCommit(
    [stringStore, tupleStore, recordStore, documentStore, revisionStore],
    payload => persist(file, payload, position).then(next => position = next),
  );
  return revision => commit(write => revisionStore.getKey(write, revision));
}

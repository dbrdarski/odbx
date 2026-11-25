import { createCommit } from "./commit.mjs";
import { persist } from "./persist.mjs";

export function createWriter(stores, file, position = 0) {
  const { stringStore, tupleStore, recordStore, documentStore, revisionStore } = stores;
  const append = payload => persist(file, payload, position).then(next => position = next);
  const commit = createCommit(
    [stringStore, tupleStore, recordStore, documentStore, revisionStore],
    append,
  );
  const write = operation => commit(write => {
    const [revision, relationsMap] = operation();
    revisionStore.getKey(write, revision);
    return [revision, relationsMap];
  });
  write.fork = task => commit.enqueue(() => task(append));
  return write;
}

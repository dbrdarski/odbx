import { open } from "node:fs/promises";
import { createStores } from "./stores.mjs";
import { createWriter } from "./writer.mjs";

const createDatabase = file => {
  const stores = createStores();
  const write = createWriter(stores, file);
  const histories = new Map();
  const revisionsById = new Map();
  const getRevisions = document => histories.get(document.id) ?? [];
  const publish = revision => {
    histories.set(revision.document.id, [...getRevisions(revision.document), revision]);
    revisionsById.set(revision.id, revision);
    return revision;
  };

  return {
    addDocumentType: stores.addDocumentType,
    save(document, options) {
      const revision = stores.createRevision(document, options);
      return write(revision).then(() => publish(revision));
    },
    latest: document => getRevisions(document).at(-1),
    revision: id => revisionsById.get(id),
    revisions: getRevisions,
    close: () => file.close(),
  };
};

export const DB = {
  create: async filename => createDatabase(await open(filename, "wx+")),
};

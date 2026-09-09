import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { replay } from "./replay.mjs";
import { createStores } from "./stores.mjs";
import { createWriter } from "./writer.mjs";

const createDatabase = async (file, bytes) => {
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
  if (bytes) {
    const endOffset = replay(stores, bytes, publish);
    if (endOffset < bytes.length) await file.truncate(endOffset);
  }

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
  open: async filename => {
    const file = await open(filename, constants.O_RDWR | constants.O_APPEND);
    return createDatabase(file, await file.readFile());
  },
};

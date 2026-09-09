import { open } from "node:fs/promises";
import { replay } from "./replay.mjs";
import { createStores } from "./stores.mjs";
import { createWriter } from "./writer.mjs";

const createDatabase = async (file, bytes) => {
  const stores = createStores();
  const histories = new Map();
  const revisionsById = new Map();
  const getRevisions = document => histories.get(document.id) ?? [];
  const publish = revision => {
    histories.set(revision.document.id, [...getRevisions(revision.document), revision]);
    revisionsById.set(revision.id, revision);
    return revision;
  };
  const latest = document => getRevisions(document).at(-1);
  const endOffset = bytes ? replay(stores, bytes, publish) : 0;
  if (bytes?.length > endOffset) await file.truncate(endOffset);
  const write = createWriter(stores, file, endOffset);
  const save = (document, options) => {
    const revision = stores.createRevision(document, options);
    return write(revision).then(() => publish(revision));
  };
  const setArchived = (document, metadata, archived) => {
    const revision = latest(document);
    return save(document, {
      metadata: { ...metadata, from: revision.id },
      data: revision.data,
      archived,
    });
  };

  return {
    addDocumentType: stores.addDocumentType,
    save,
    archive: (document, metadata) => setArchived(document, metadata, true),
    restore: (document, metadata) => setArchived(document, metadata, false),
    latest,
    revision: id => revisionsById.get(id),
    revisions: getRevisions,
    close: () => file.close(),
  };
};

export const DB = {
  create: async filename => createDatabase(await open(filename, "wx+")),
  open: async filename => {
    const file = await open(filename, "r+");
    return createDatabase(file, await file.readFile());
  },
};

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
  const latest = options => options?.id
    ? getRevisions(options).at(-1)
    : Array.from(histories.values(), revisions => revisions.at(-1)).filter(
      revision => options?.archived === null || revision.archived === (options?.archived ?? false),
    );
  const endOffset = bytes ? replay(stores, bytes, publish) : 0;
  if (bytes?.length > endOffset) await file.truncate(endOffset);
  const write = createWriter(stores, file, endOffset);
  const save = (document, options) => {
    const revision = stores.createRevision(document, options);
    return write(() => revision).then(publish);
  };
  const setArchived = (id, metadata, archived) => write(() => {
    const revision = latest({ id });
    return stores.createRevision(revision.document, {
      metadata: { ...metadata, from: revision.id },
      data: revision.data,
      archived,
    });
  }).then(publish);

  return {
    addDocumentType: stores.addDocumentType,
    save,
    archive: (id, metadata) => setArchived(id, metadata, true),
    restore: (id, metadata) => setArchived(id, metadata, false),
    latest,
    revision: id => revisionsById.get(id),
    revisions: getRevisions,
    close: () => file.close(),
  };
};

export const DB = {
  create: async filename => createDatabase(await open(filename, "wx+")),
  open: filename => open(filename, "r+").then(file =>
    file.readFile()
      .then(bytes => createDatabase(file, bytes))
      .catch(error => file.close().then(() => Promise.reject(error))),
  ),
};

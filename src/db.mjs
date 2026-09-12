import { open } from "node:fs/promises";
import { replay } from "./replay.mjs";
import { createStores } from "./stores.mjs";
import { createWriter } from "./writer.mjs";

const createDatabase = async (file, bytes) => {
  const stores = createStores();
  const entities = Object.create(null);
  const getEntity = type => entities[type] ??= {
    histories: new Map(),
    revisions: new Map(),
  };
  const publish = revision => {
    const entity = getEntity(revision.document.type);
    const history = entity.histories.get(revision.document.id) ?? [];
    entity.histories.set(revision.document.id, [...history, revision]);
    entity.revisions.set(revision.id, revision);
    return revision;
  };
  const endOffset = bytes ? replay(stores, bytes, publish) : 0;
  if (bytes?.length > endOffset) await file.truncate(endOffset);
  const write = createWriter(stores, file, endOffset);
  const save = operation => write(operation).then(publish);
  const createEntity = name => {
    const { createDocument } = stores.addDocumentType(name);
    const { histories, revisions } = getEntity(name);
    const getRevisions = document => histories.get(document.id) ?? [];
    const latest = options => options?.id
      ? getRevisions(options).at(-1)
      : Array.from(histories.values(), revisions => revisions.at(-1)).filter(
        revision => options?.archived === null || revision.archived === (options?.archived ?? false),
      );
    const setArchived = (id, archived) => save(() => {
      const revision = latest({ id });
      return stores.createRevision(revision.document, {
        from: revision.id,
        data: revision.data,
        archived,
      });
    });
    return {
      create: data => save(() => stores.createRevision(createDocument(), { data })),
      update: (id, data, { from }) => save(() => {
        const revision = latest({ id });
        if (revision.archived) throw Error("Cannot update archived document");
        return stores.createRevision(revision.document, { data, from });
      }),
      archive: id => setArchived(id, true),
      restore: id => setArchived(id, false),
      latest,
      revision: id => revisions.get(id),
      revisions: getRevisions,
    };
  };

  return {
    createEntity,
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

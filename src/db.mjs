import { open } from "node:fs/promises";
import { replay } from "./replay.mjs";
import { Schema, validate } from "./schema.mjs";
import { createStores } from "./stores.mjs";
import { createWriter } from "./writer.mjs";

const createDatabase = async (file, bytes, definitions) => {
  const stores = createStores();
  const definitionEntries = Object.entries(definitions);
  definitionEntries.forEach(([, entity]) => entity());
  const entityStates = Object.create(null);
  for (const [type, entity] of definitionEntries) {
    const { createDocument } = stores.addDocumentType(type);
    entityStates[type] = {
      createDocument,
      validator: Schema(entity().schema),
      histories: new Map(),
      revisions: new Map(),
    };
  }
  const getEntityState = type => {
    const state = entityStates[type];
    if (!state) throw Error(`Unknown document type: ${type}`);
    return state;
  };
  const publish = revision => {
    const state = getEntityState(revision.document.type);
    const history = state.histories.get(revision.document.id) ?? [];
    state.histories.set(revision.document.id, [...history, revision]);
    state.revisions.set(revision.id, revision);
    return revision;
  };
  const replayRevision = revision => {
    const { validator } = getEntityState(revision.document.type);
    const [validationResult] = validate(validator, revision.data);
    if (validationResult !== true) throw validationResult;
    return publish(revision);
  };
  const endOffset = bytes ? replay(stores, bytes, replayRevision) : 0;
  if (bytes?.length > endOffset) await file.truncate(endOffset);
  const write = createWriter(stores, file, endOffset);
  const save = operation => write(operation).then(publish);
  const createFacade = ({ createDocument, validator, histories, revisions }) => {
    const getRevisions = document => histories.get(document.id) ?? [];
    const latest = options => options?.id
      ? getRevisions(options).at(-1)
      : Array.from(histories.values(), revisions => revisions.at(-1)).filter(
        revision => options?.archived === null || revision.archived === (options?.archived ?? false),
      );
    const createRevision = (document, options) => {
      const revision = stores.createRevision(document, options);
      const [validationResult] = validate(validator, revision.data);
      if (validationResult !== true) throw validationResult;
      return revision;
    };
    const setArchived = (id, archived) => save(() => {
      const revision = latest({ id });
      return createRevision(revision.document, {
        from: revision.id,
        data: revision.data,
        archived,
      });
    });
    return {
      create: data => save(() => createRevision(createDocument(), { data })),
      update: (id, data, { from }) => save(() => {
        const revision = latest({ id });
        if (revision.archived) throw Error("Cannot update archived document");
        return createRevision(revision.document, { data, from });
      }),
      archive: id => setArchived(id, true),
      restore: id => setArchived(id, false),
      latest,
      revision: id => revisions.get(id),
      revisions: getRevisions,
    };
  };
  const entities = Object.create(null);
  for (const [type, state] of Object.entries(entityStates)) {
    entities[type] = createFacade(state);
  }

  return {
    entities,
    close: () => file.close(),
  };
};

export const DB = {
  create: (filename, definitions) => open(filename, "wx+").then(file =>
    createDatabase(file, undefined, definitions)
      .catch(error => file.close().then(() => Promise.reject(error))),
  ),
  open: (filename, definitions) => open(filename, "r+").then(file =>
    file.readFile()
      .then(bytes => createDatabase(file, bytes, definitions))
      .catch(error => file.close().then(() => Promise.reject(error))),
  ),
};

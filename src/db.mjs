import { open } from "node:fs/promises";
import { replay } from "./replay.mjs";
import { Schema, validate } from "./schema.mjs";
import { createStores } from "./stores.mjs";
import { createWriter } from "./writer.mjs";

const publishRevision =
  (histories, revisions, relationshipSnapshots) =>
    ([revision, relationsMap]) => {
      const history = histories.get(revision.document.id) ?? [];
      history.push(revision);
      histories.set(revision.document.id, history);
      revisions.set(revision.id, revision);
      relationshipSnapshots.set(revision.document.id, relationsMap);
      return revision;
    };

const createDatabase = async (file, bytes, definitions) => {
  const stores = createStores();
  const definitionEntries = Object.entries(definitions);
  definitionEntries.forEach(([, entity]) => entity());
  const entityStates = Object.create(null);
  const statesByEntity = new Map();
  for (const [type, entity] of definitionEntries) {
    const { createDocument } = stores.addDocumentType(type);
    const histories = new Map();
    const revisions = new Map();
    const relationshipSnapshots = new Map();
    const state = entityStates[type] = {
      createDocument,
      validator: Schema(entity().schema),
      histories,
      revisions,
      relationshipSnapshots,
      publish: publishRevision(histories, revisions, relationshipSnapshots),
    };
    statesByEntity.set(entity, state);
  }
  const getEntityState = type => {
    const state = entityStates[type];
    if (!state) throw Error(`Unknown document type: ${type}`);
    return state;
  };
  const hasOne = relationship =>
    Object.values(relationship.target().relationships).some(
      inverse => inverse.kind === "hasOne" && inverse.target === relationship,
    );
  const validateReference = revision => (relationship, id) => {
    const target = statesByEntity.get(relationship.target);
    if (!target?.histories.has(id)) return false;
    if (revision.archived || !hasOne(relationship)) return true;
    const source = statesByEntity.get(relationship.source);
    return Array.from(source.relationshipSnapshots).every(
      ([documentId, relationships]) =>
        documentId === revision.document.id ||
        source.histories.get(documentId).at(-1).archived ||
        !relationships.get(relationship)?.has(id),
    );
  };
  const validateRevision = (validator, revision) =>
    validate(validator, revision.data, validateReference(revision));
  const replayRevision = revision => {
    const { validator, publish } = getEntityState(revision.document.type);
    const [validationResult, relationsMap] = validateRevision(validator, revision);
    if (validationResult !== true) throw validationResult;
    return publish([revision, relationsMap]);
  };
  const endOffset = bytes ? replay(stores, bytes, replayRevision) : 0;
  if (bytes?.length > endOffset) await file.truncate(endOffset);
  const write = createWriter(stores, file, endOffset);
  const createFacade = ({ createDocument, validator, histories, revisions, publish }) => {
    const save = operation => write(operation).then(publish);
    const getRevisions = document => histories.get(document.id) ?? [];
    const latest = options => options?.id
      ? getRevisions(options).at(-1)
      : Array.from(histories.values(), revisions => revisions.at(-1)).filter(
        revision => options?.archived === null || revision.archived === (options?.archived ?? false),
      );
    const createRevision = (document, options) => {
      const revision = stores.createRevision(document, options);
      const [validationResult, relationsMap] = validateRevision(validator, revision);
      if (validationResult !== true) throw validationResult;
      return [revision, relationsMap];
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
    createDatabase(file, null, definitions)
      .catch(error => file.close().then(() => Promise.reject(error))),
  ),
  open: (filename, definitions) => open(filename, "r+").then(file =>
    file.readFile()
      .then(bytes => createDatabase(file, bytes, definitions))
      .catch(error => file.close().then(() => Promise.reject(error))),
  ),
};

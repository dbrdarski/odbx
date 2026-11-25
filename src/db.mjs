import { open, readFile, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { replay } from "./replay.mjs";
import { Schema, validate } from "./schema.mjs";
import { createStores } from "./stores.mjs";
import { deepClone } from "./utils.mjs";
import { createWriter } from "./writer.mjs";

const validForkIdentifier = identifier => typeof identifier === "string"
  ? /^[a-z_][a-z0-9_]*$/.test(identifier)
  : Number.isSafeInteger(identifier) && identifier >= 0;
const validForkName = name => typeof name === "string" && validForkIdentifier(name);

const forkFilename = (rootPath, identifiers) => identifiers.length
  ? [rootPath.replace(/\.odbx$/, ""), ...identifiers, "odbx"].join(".")
  : rootPath;

const readForkPath = async (rootPath, forkPath) => {
  if (!Array.isArray(forkPath) || !forkPath.every(validForkIdentifier))
    throw new TypeError("Invalid fork path");
  if (forkPath.length && !rootPath.endsWith(".odbx"))
    throw new TypeError("Fork root filename must end in .odbx");
  const path = [...forkPath];
  return {
    path,
    targetPath: forkFilename(rootPath, path),
    steps: await Promise.all(path.map(async (identifier, index) => ({
      bytes: await readFile(forkFilename(rootPath, path.slice(0, index))),
      identifier,
    }))),
  };
};

const publishRevision =
  (histories, revisions, relationshipSnapshots) =>
    ([revision, relationsMap]) => {
      const history = histories.get(revision.document.id) ?? [];
      history.push(revision);
      histories.set(revision.document.id, history);
      revisions.set(revision.id, revision);
      relationshipSnapshots.forEach(snapshots => snapshots.delete(revision.document.id));
      relationsMap.forEach((ids, relationship) => {
        const snapshots = relationshipSnapshots.get(relationship) ?? new Map();
        snapshots.set(revision.document.id, ids);
        relationshipSnapshots.set(relationship, snapshots);
      });
      return revision;
    };

const createDatabase = async (file, bytes, definitions, parent, {
  rootPath, forkPath = [], steps = [],
} = {}) => {
  const stores = parent?.stores.fork() ?? createStores();
  const definitionEntries = Object.entries(definitions);
  definitionEntries.forEach(([, entity]) => entity());
  const entityStates = Object.create(null);
  const statesByEntity = new Map();
  for (const [type, entity] of definitionEntries) {
    const { createDocument } = stores.addDocumentType(type);
    const { histories, revisions, relationshipSnapshots } =
      deepClone(parent?.entityStates[type]) ?? {
        histories: new Map(),
        revisions: new Map(),
        relationshipSnapshots: new Map(),
      };
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
    if (!hasOne(relationship)) return true;
    const source = statesByEntity.get(relationship.source);
    return Array.from(source.relationshipSnapshots.get(relationship) ?? []).every(
      ([documentId, ids]) =>
        documentId === revision.document.id ||
        !ids.has(id),
    );
  };
  const validateRevision = (validator, revision) =>
    validate(validator, revision.data, validateReference(revision));
  const createRelationship = relationship => {
    const owning = relationship.inverse ? relationship.target : relationship;
    const source = statesByEntity.get(owning.source);
    const target = statesByEntity.get(relationship.inverse ? owning.source : owning.target);
    const related = relationship.inverse
      ? (sourceId, targetId) =>
        source.relationshipSnapshots.get(owning)?.get(targetId)?.has(sourceId)
      : (sourceId, targetId) =>
        source.relationshipSnapshots.get(owning)?.get(sourceId)?.has(targetId);
    const single = relationship.kind === "belongsToOne" || relationship.kind === "hasOne";
    const relationshipLatest = (sourceId, options) => {
      const revisions = Array.from(target.histories)
        .filter(([targetId]) => related(sourceId, targetId))
        .map(([, history]) => history.at(-1))
        .filter(revision =>
          options?.archived === null ||
          revision.archived === (options?.archived ?? false)
        );
      return single ? revisions[0] ?? null : revisions;
    };
    return {
      latest: relationshipLatest,
      revisions: (sourceId, options) =>
        [].concat(relationshipLatest(sourceId, options) ?? [])
          .flatMap(revision => target.histories.get(revision.document.id)),
    };
  };
  const replayRevision = revision => {
    const { validator, publish } = getEntityState(revision.document.type);
    const [validationResult, relationsMap] = validateRevision(validator, revision);
    if (validationResult !== true) throw validationResult;
    return publish([revision, relationsMap]);
  };
  const forks = { nextIndex: 0, children: new Map() };
  const path = forkFilename(rootPath, forkPath);
  const registerFork = ({ name }) => {
    const identifier = name === null ? forks.nextIndex++ : name;
    forks.children.set(identifier, forkFilename(rootPath, [...forkPath, identifier]));
  };
  const endOffset = bytes ? replay(stores, bytes, replayRevision, steps, registerFork) : 0;
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
  for (const [type, entity] of definitionEntries) {
    entities[type] = {
      ...createFacade(entityStates[type]),
      ...Object.fromEntries(Object.entries(entity().relationships).map(
        ([name, relationship]) => [name, createRelationship(relationship)],
      )),
    };
  }

  return {
    entities,
    info: () => ({
      filename: basename(path),
      path,
      rootPath,
      forkPath: [...forkPath],
      forks: [...forks.children.keys()],
    }),
    fork: name => write.fork(async append => {
      if (name != null && !validForkName(name)) throw new TypeError("Invalid fork name");
      const childForkPath = [...forkPath, name ?? forks.nextIndex];
      const childPath = forkFilename(rootPath, childForkPath);
      const childFile = await open(childPath, "wx+");
      try {
        const child = await createDatabase(childFile, null, definitions,
          { stores, entityStates }, { rootPath, forkPath: childForkPath });
        await append(name == null ? "@" : `@${name}`);
        registerFork({ name: name ?? null });
        return child;
      } catch (error) {
        await childFile.close();
        await unlink(childPath);
        throw error;
      }
    }),
    openFork: (...descendants) => forks.children.has(descendants[0])
      ? DB.open(rootPath, definitions, [...forkPath, ...descendants])
      : Promise.reject(Error(`Unknown fork: ${descendants[0]}`)),
    close: write.close,
  };
};

export const DB = {
  create: (filename, definitions) => open(filename, "wx+").then(file =>
    createDatabase(file, null, definitions, null, { rootPath: resolve(filename) })
      .catch(error => file.close().then(() => Promise.reject(error))),
  ),
  open: (filename, definitions, forkPath = []) => {
    const rootPath = resolve(filename);
    return readForkPath(rootPath, forkPath).then(({ path, targetPath, steps }) =>
      open(targetPath, "r+").then(file =>
        file.readFile()
          .then(bytes => createDatabase(file, bytes, definitions, null, {
            rootPath, forkPath: path, steps,
          }))
          .catch(error => file.close().then(() => Promise.reject(error))),
      ),
    );
  },
};

# ODBX schema and relationships plan

## Public definition surface

Entity definitions live in a normal JavaScript module:

```javascript
import {
  createEntity,
  Tuple,
  Union,
  UUID,
} from "odbx"

class TitleAndSlug {
  title = String
  slug = String
}

class Vdom {
  tag = String
  children = Tuple.of(Union(Vdom, String))
}

export const post = createEntity(({ belongsToMany }) => {
  class Taxonomies {
    tags = Tuple.of(UUID(post.tag))
  }

  return {
    relationships: {
      tag: belongsToMany(tag),
    },

    schema: class Post {
      header = TitleAndSlug
      body = Tuple.of(Vdom)
      taxonomies = Taxonomies
    },
  }
})

export const tag = createEntity(({ hasMany }) => ({
  relationships: {
    post: hasMany(post.tag),
  },

  schema: TitleAndSlug,
}))
```

`createEntity()` does not run its factory during module evaluation. It returns a
lazy entity definition, allowing definitions to reference entities declared
later in the module.

There is no entity-name argument. During database initialization, the module
export name supplies the stored document type:

```text
post -> "post"
tag  -> "tag"
```

## Relationship definitions

An owning helper creates a normal frozen object. For example,
`belongsToMany(tag)` produces the equivalent of:

```javascript
Object.freeze({
  kind: "belongsToMany",
  source: post,
  target: tag,
})
```

The containing property establishes its public identity:

```javascript
post.tag
```

Two relationships targeting the same entity remain distinct:

```javascript
post.author !== post.editor
```

Inverse definitions are separate relationship objects:

```javascript
tag.post
```

The linker privately records that `tag.post` is the inverse of `post.tag`.
This private link is necessary because `{ kind, source, target }` alone cannot
distinguish multiple relationships between the same entity pair.

No public `direction` or `cardinality` fields are needed. The helper kind
already conveys both.

## Database initialization

Both creating and opening a database receive the entity-definition module:

```javascript
import * as definitions from "./entities.mjs"

const db = await DB.open("content.odbx", definitions)
```

Initialization occurs in this order:

1. Register every exported entity definition and its export name.
2. Resolve all lazy entity factories.
3. Install relationship properties such as `post.tag`.
4. Link inverse relationships such as `tag.post -> post.tag`.
5. Compile every schema.
6. Create database-local entity state and relationship indexes.
7. Replay the persisted revisions.

This makes schemas and relationships available before replay begins.

The current runtime API is removed:

```javascript
db.createEntity("post")
```

Database initialization instead creates the runtime entity facades. They will
be destructured from a namespaced property to avoid collisions with database
methods:

```javascript
const { post, tag } = db.entities
```

`entities` is the runtime entity namespace.

The runtime facade retains the existing entity operations:

```javascript
post.create(data)
post.update(id, data, { from })
post.archive(id)
post.restore(id)

post.latest(options)
post.revision(id)
post.revisions(document)
```

The module definition retains the stable relationship definition used by the
schema:

```javascript
definitions.post.tag
```

The runtime entity facade exposes a database-bound relationship API at the
same property:

```javascript
db.entities.post.tag
```

The bound API retains the stable relationship definition privately and reads
the current database's relationship index. Each database keeps its own index
state keyed by the stable definition.

## Schema compilation

Schema classes are normalized to Oddo `Record` shapes internally.

The compiler handles:

```javascript
String
Number
Boolean
null

Tuple(String, Number)
Tuple.of(String)

Union(String, Number)

UUID(post.tag)

class NestedShape {
  value = String
}
```

The rules are:

- A schema class describes a `Record`.
- Record keys are sorted consistently with Oddo Records.
- `Tuple(A, B)` means a fixed positional Tuple.
- `Tuple.of(A)` means an any-length Tuple whose items validate against `A`.
- `Union(A, B)` is binary.
- `UUID(post.tag)` validates and captures a relationship reference.
- Plain JavaScript objects and arrays are not schema shapes.

Recursive classes require placeholder caching:

1. Create and cache an unfinished validator for the class.
2. Instantiate and inspect the schema class.
3. Compile its fields.
4. Complete the cached validator.

This allows:

```javascript
class Vdom {
  children = Tuple.of(Union(Vdom, String))
}
```

### Required `Tuple.of` correction

The currently inherited `Array.of` implementation returns an ordinary Tuple.
It does not preserve enough information for the compiler to distinguish:

```javascript
Tuple(Number)
```

from:

```javascript
Tuple.of(Number)
```

Therefore the agreed `Tuple.of(...)` schema surface needs a distinct internal
schema descriptor. This is necessary for the selected syntax.

## Validation

A compiled validator has this interface:

```javascript
const [validationResult, relationsMap] =
  validate(value, validationRun)
```

`validationResult` is:

```javascript
true | validationError
```

`relationsMap` is always returned:

```javascript
Map([
  [post.tag, new Set([tagId])],
])
```

A `ValidationRun` owns:

- the current path;
- the collected validation failures;
- the transient relationship captures;
- access to the current database state.

Nested validators use:

```javascript
run.branch("taxonomies")
run.branch("tags")
run.branch(0)
```

All branches contribute to the same root result.

Leaf validators return either `true` or one validation issue. Record and Tuple
validators are the collection points: while iterating their children, they add
returned issues to the shared run. Class schemas remain Record/shape
validators and therefore follow the Record rule.

If a Record or Tuple cannot be iterated because the value itself has the wrong
type, that validator returns its own issue. If it can iterate, it collects the
specific child issues without also adding a generic parent failure. Record
iteration reports missing and unexpected properties; Tuple iteration reports
its own length and item failures. A direct issue at the root is collected by
the top-level validation wrapper because it has no parent container.

Union alternatives validate in isolation. Failed alternatives cannot leak
errors or relationship captures into the accepted alternative. If either
alternative succeeds, its relationship captures are accepted. If both fail,
the Union returns one issue containing the stringified Union shape rather than
the failures from both alternatives. The containing Record or Tuple then
collects that issue. For example:

```javascript
#{
  code: "type",
  path: Tuple("body", 1),
  expected: "Vdom | String",
  received: "Boolean",
}
```

Each failing location produces its own issue. A constraint involving UUIDs in
several positions therefore produces an issue at each affected UUID path,
rather than one grouped issue at the root.

`validationError` is one native `ValidationError extends Error` containing a
flat Oddo Tuple of Oddo Record issues:

```javascript
validationError.errors
```

Every issue contains `code` and `path`. `path` is a Tuple of string and number
segments. The remaining fields depend on the issue code, such as
`expected`/`received` for a type mismatch or `relationship`/`id` for a UUID
failure. Issues do not retain the complete invalid value; a small value such as
a missing UUID may be included when it identifies the failure. Issues are not
grouped by code.

Validation succeeds with `true` when no issues were collected. Otherwise it
returns the `ValidationError` containing all collected issues.

## Relationship validation

`UUID(post.tag)` can occur anywhere in the Record/Tuple tree. Every occurrence
contributes to the same Set under `post.tag`.

The cardinality rules are:

- `belongsToMany` accepts any number of distinct target IDs.
- `belongsToOne` accepts repeated occurrences of the same ID, but fails if the
  completed document captures more than one distinct ID.
- `hasOne` checks that its target is not already related to another active
  source document.
- `hasMany` imposes no inverse uniqueness constraint.

Archived target documents remain valid relationship references. `UUID()`
checks that the referenced document exists, regardless of its current archived
state. Relationship reads use the same archive filtering as entity reads:

- `archived: false` selects active documents;
- `archived: true` selects archived documents;
- `archived: null` selects both.

## Live writes

The complete operation runs inside the existing write queue:

1. Read the queue-current document and relationship state.
2. Validate the proposed Record.
3. Check relationship cardinality and inverse constraints.
4. Reject without writing if validation fails.
5. Create and persist the revision.
6. Publish the revision to the entity state.
7. Publish its relationship snapshot to the relationship indexes.

All conditions that may reject are checked before persistence.

If persistence fails, both the revision and transient relationship capture are
discarded.

## Replay

Replay uses the same compiled validators and relationship publication logic:

1. Reconstruct a persisted revision.
2. Select its entity definition using `revision.document.type`.
3. Validate its data.
4. Capture its relationships.
5. Publish the revision and relationship state.

An unknown document type or invalid persisted document causes `DB.open()` to
reject.

No schema or relationship definitions are serialized. The persistent ODBX
format does not need to change.

## Relationship indexes

Each owning relationship has one database-local edge state:

```javascript
{
  forward: Map<sourceDocumentId, Set<targetDocumentId>>,
  inverse: Map<targetDocumentId, Set<sourceDocumentId>>,
}
```

The inverse relationship uses this same state with the direction reversed. It
does not maintain another independent index.

Publishing a new revision replaces that source document's previous
relationship snapshot:

1. Remove previous forward targets.
2. Remove the matching inverse entries.
3. Install the new forward targets.
4. Install the matching inverse entries.

Simply adding new targets would leave stale relationships.

Archiving a source document does not erase its relationship snapshot. The
archive revision retains the document data, and therefore retains the same
captured relationships. Incoming relationships also remain when a target is
archived. A source document's archived state does not prevent relationship
traversal. Reads apply `archived: false`, `true`, or `null` to the returned
target documents. Restoring a document changes its archive state without
reconstructing relationships from a separate source.

## Relationship reads

Runtime relationships navigate from a source document to the related target
documents:

```javascript
post.tag.latest(postId, { archived: false })
tag.post.latest(tagId, { archived: null })
```

`post.tag` traverses from a post to its tags. The inverse `tag.post` traverses
from a tag to its posts. `latest()` uses the source document's latest
relationship snapshot and resolves the latest revisions of its targets.

For `belongsToOne` and `hasOne`, `latest()` returns one target revision or
`null`. It never returns `undefined`. For `belongsToMany` and `hasMany`, it
returns an Array of target revisions. A missing source document has the same
result as a source with no related targets: `null` for to-one relationships and
an empty Array for to-many relationships.

To-many results follow the target entity's document insertion order, matching
the entity collection form of `latest()`. Each target appears once even if its
UUID occurs more than once in the source document.

The `archived` option filters the returned target documents and follows the
same behavior as entity reads:

- omission or `false` returns active targets;
- `true` returns archived targets;
- `null` returns both.

Relationship APIs are read-only. Creating, updating, archiving, and restoring
documents remain operations on entity APIs.

`relationship.revisions(sourceId)` has an unambiguous future meaning: select
the currently related target documents, then return all revisions of those
target documents. It is deferred from the initial API because the same result
can be composed from `relationship.latest()` and the target entity's
`revisions()` method.

Historical relationship membership is a separate future feature. Its API is
not part of this plan. Deferring it does not require a storage-format migration
because persisted revisions retain the data from which relationship snapshots
are derived.

## Implementation sequence

1. Add the schema descriptors: `Union`, `UUID`, and distinguishable
   `Tuple.of`.
2. Add lazy `createEntity()` definitions and frozen relationship objects.
3. Add entity linking, inverse linking, and recursive schema compilation.
4. Add `ValidationRun`, complete-error collection, and relationship capture.
5. Change database initialization to accept definitions before replay.
6. Create runtime entity facades and remove `db.createEntity(name)`.
7. Validate live writes inside the queue before persistence.
8. Validate replayed revisions before publication.
9. Add forward/inverse relationship publication and replacement.
10. Add database-bound relationship `latest()` reads.

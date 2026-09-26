# ODBX schema and relationships plan

## Public definition surface

Entity definitions live in a normal JavaScript module:

```javascript
import {
  createEntity,
  Union,
  UUID,
} from "odbx"
import { Tuple } from "odbx/helpers"

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
  inverse: false,
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

Inverse definitions are separate frozen relationship objects. An inverse helper
receives the owning relationship and stores it as its target:

```javascript
Object.freeze({
  kind: "hasMany",
  source: tag,
  target: post.tag,
  inverse: true,
})
```

This direct link distinguishes multiple relationships between the same entity
pair without a separate linker or inverse map.

No separate `direction` or `cardinality` fields are needed. The helper kind
conveys cardinality, and `inverse` identifies which direction the descriptor
represents.

## Database initialization

Both creating and opening a database receive the entity-definition module:

```javascript
import * as definitions from "./entities.mjs"

const db = await DB.open("content.odbx", definitions)
```

Initialization occurs in this order:

1. Create the value stores and collect every exported entity definition with
   its export name.
2. Resolve all lazy entity factories.
3. Register each document type, compile its schema, and create its histories,
   revision lookup, and relationship snapshots.
4. Replay, validate, and publish every complete persisted Revision.
5. Truncate any incomplete tail after the last complete Revision.
6. Create the writer and the database-bound entity and relationship facades.

This makes schemas and relationship definitions available before replay begins.

There is no runtime entity-definition API:

```javascript
db.createEntity("post")
```

Database initialization creates the runtime entity facades. They are
destructured from a namespaced property to avoid collisions with database
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
the current database's histories and relationship snapshots. Each database
keeps this state independently.

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

Resolved validators live in a process-wide `Map` keyed by the original schema.
A class validator normalizes one instance to a Record definition, while child
schemas are resolved only when validation reaches them. Once the outer class
validator is in the Map, a recursive child resolves back to it. This allows:

```javascript
class Vdom {
  children = Tuple.of(Union(Vdom, String))
}
```

### `Tuple.of`

`Tuple.of` is a schema-validator factory with its own identity. It lets schema
resolution distinguish:

```javascript
Tuple(Number)
```

from:

```javascript
Tuple.of(Number)
```

`Tuple(Number)` is an Oddo Tuple used as a fixed positional schema.
`Tuple.of(Number)` returns a named validator for any-length Tuples of Numbers.

## Validation

A compiled validator has the internal interface `(value, run)`. The public
validation wrapper has this interface:

```javascript
const [validationResult, relationsMap] =
  validate(schema, value, validateReference)
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
- the optional reference-validation callback.

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
missing or unexpected positions and item failures. A direct issue at the root
is collected by the top-level validation wrapper because it has no parent
container.

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

`UUID(post.tag)` can occur anywhere in the Record/Tuple tree. It first requires
a UUID-v4 string, then contributes the ID to the same Set under `post.tag`, and
finally calls the reference validator when one was supplied.

The cardinality rules are:

- `belongsToMany` accepts any number of distinct target IDs.
- `belongsToOne` accepts repeated occurrences of the same ID, but fails if the
  completed document captures more than one distinct ID.
- `hasOne` checks that its target is not already related to another source
  document, including an archived source. Updating the same source document is
  allowed.
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
5. Serialize and persist the Revision.
6. Publish the Revision, its history entry, and its captured relations map.

All validation and relationship conditions are checked before persistence.

If persistence fails, the value-store transaction is restored and neither the
Revision nor its relationship snapshot is published. The logical write
position remains unchanged, so a retry writes from that position. Opening the
database truncates any incomplete physical tail after the last complete
Revision.

## Replay

Replay uses the same compiled validators and relationship publication logic:

1. Reconstruct a persisted Revision.
2. Select its entity definition using `revision.document.type`.
3. Validate its data.
4. Capture its relationships.
5. Publish the Revision and relationship state.

An unknown document type or invalid persisted document causes `DB.open()` to
reject.

No schema or relationship definitions are serialized. The persistent ODBX
format does not need to change.

## Relationship snapshots

Each entity keeps the latest captured relationships for each of its source
documents:

```javascript
Map([
  [sourceDocumentId, Map([
    [owningRelationship, new Set([targetDocumentId])],
  ])],
])
```

Publishing a successful Revision replaces that source document's entire
snapshot with `relationshipSnapshots.set(documentId, relationsMap)`. Owning
reads use the source document's Set directly. Inverse reads scan the owning
entity's current snapshots in the opposite direction. There are no separate
forward and inverse indexes.

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
const { post: posts, tag: tags } = db.entities

posts.tag.latest(postId, { archived: false })
tags.post.latest(tagId, { archived: null })
```

`posts.tag` traverses from a post to its tags. The inverse `tags.post` traverses
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

`relationship.revisions(sourceId, options)` selects targets using the same
current membership and archive filter as `latest()`, then returns a flat Array
containing each selected target document's complete Revision history. It always
returns an Array, including for to-one relationships. Results follow target
document insertion order, then Revision order. When no target is selected, it
returns an empty Array.

Historical relationship membership is a separate future feature. Its API is
not part of this plan. Deferring it does not require a storage-format migration
because persisted revisions retain the data from which relationship snapshots
are derived.

## Implemented scope

The completed implementation includes:

1. Lazy entity definitions and frozen owning/inverse relationship descriptors.
2. Primitive, Record, fixed Tuple, `Tuple.of`, binary Union, and UUID
   validators with recursive class support.
3. Complete validation issue collection and transient relationship capture.
4. Database initialization from entity definitions before replay.
5. Database-bound entity facades under `db.entities`.
6. Validation of both live and replayed Revisions before publication.
7. Replacement of each source document's current relationship snapshot after
   successful persistence.
8. Forward and inverse `latest()` and `revisions()` relationship reads.
9. Focused schema, relationship, archive, failure, and replay tests.

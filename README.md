# odbx

**odbx** is an experimental append-only database implemented in JS.

Each change creates a new revision, so documents retain their complete history.
Documents can be archived and restored without deleting earlier revisions.

## Status

odbx is an early development preview and is not ready for production use. The
package is currently private and is not published to npm. It requires Node.js 22
or later and uses ES modules.

## Values

Document bodies must be Oddo `Record` values. Records may contain strings,
numbers, booleans, `null`, other Records, and ordered `Tuple` values.

```js
import { Record, Tuple } from "odbx";

const article = Record({
  title: "Introducing odbx",
  tags: Tuple("database", "javascript"),
});
```

Tuples preserve order. Records are unordered, so Records with the same fields
and values are the same canonical value regardless of field insertion order.

## Creating a database

Define the database's entity types in a JavaScript module. Its export names
become the stored document types:

```js
// entities.mjs
import { createEntity } from "odbx";

export const post = createEntity(() => ({
  schema: class Post {
    title = String;
  },
}));
```

Pass the module when creating or opening the database:

```js
import { DB, Record } from "odbx";
import * as definitions from "./entities.mjs";

const db = await DB.create("./content.odbx", definitions);
const posts = db.entities.post;

const created = await posts.create(Record({ title: "First post" }));

console.log(created.id);          // Revision ID
console.log(created.document.id); // Document ID
```

Each entity provides `create`, `update`, `archive`, and `restore`:

```js
const updated = await posts.update(
  created.document.id,
  Record({ title: "Edited post" }),
  { from: created.id },
);

const archived = await posts.archive(created.document.id);
const restored = await posts.restore(created.document.id);
```

`create`, `update`, `archive`, and `restore` each return the Revision they
created. odbx generates revision timestamps automatically. The first Revision
has `metadata.from === null`; updates receive their ancestor Revision ID through
`{ from }`. Archive and restore use the latest Revision as their ancestor and
retain its document body.

Updating an archived document throws. Restore it before applying another
update.

## Reading revisions

```js
const documentId = created.document.id;

posts.latest({ id: documentId });  // latest Revision for one document
posts.revision(created.id);        // one Revision by Revision ID
posts.revisions({ id: documentId }); // complete history for one document
```

Collection-form `latest()` filters Revisions by their documents' current
archive state:

```js
posts.latest();                     // latest active post Revisions
posts.latest({ archived: false });  // latest active post Revisions
posts.latest({ archived: true });   // latest archived post Revisions
posts.latest({ archived: null });   // all latest post Revisions
```

These collection calls return the latest Revision for each matching document.
An exact `{ id }` lookup returns that document's latest Revision regardless of
its archive state.

## Reopening and closing

```js
await db.close();

const reopened = await DB.open("./content.odbx", definitions);
const reopenedPosts = reopened.entities.post;

// Read or write through reopened and reopenedPosts.

await reopened.close();
```

Always close the database when finished.

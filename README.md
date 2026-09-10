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
import { Record, Tuple } from 'odbx';

const article = Record({
  title: 'Introducing odbx',
  tags: Tuple('database', 'javascript'),
});
```

Tuples preserve order. Records are unordered, so Records with the same fields
and values are the same canonical value regardless of field insertion order.

## Creating a database

`DB.create()` creates a new database file. `DB.open()` opens an existing one.

```js
import { DB, Record } from 'odbx';

const db = await DB.create('./content.odbx');
const posts = db.createEntity('post');

const created = await posts.create(Record({ title: 'First post' }));

console.log(created.id);          // Revision ID
console.log(created.document.id); // Document ID
```

`createEntity(name)` returns `create`, `update`, `archive`, and `restore`. The
name becomes the type of Documents made by `create`:

```js
const updated = await posts.update(
  created.document.id,
  Record({ title: 'Edited post' }),
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

db.latest({ id: documentId });     // latest Revision for one document
db.revision(created.id);           // one Revision by Revision ID
db.revisions({ id: documentId });  // complete history for one document
```

Collection-form `latest()` filters Revisions by their documents' current
archive state:

```js
db.latest();                     // latest active Revisions
db.latest({ archived: false });  // latest active Revisions
db.latest({ archived: true });   // latest archived Revisions
db.latest({ archived: null });   // all latest Revisions
```

These collection calls return the latest Revision for each matching document.
An exact `{ id }` lookup returns that document's latest Revision regardless of
its archive state.

## Reopening and closing

```js
await db.close();

const reopened = await DB.open('./content.odbx');
const reopenedPosts = reopened.createEntity('post');

// Read or write through reopened and reopenedPosts.

await reopened.close();
```

Always close the database when finished.

# odbx

**odbx** is an experimental append-only database implemented in JS.
The database API is currently under development;
the available public API is the Oddo value layer shown below.

odbx is designed for applications where changing a document should never erase
what came before. Each save will create a new revision, keeping earlier versions
available for history, comparison, restoration, or audit.

Documents may share unchanged content between revisions. Editing one part does
not require duplicating the rest of the document, making complete historical
snapshots practical.

## What odbx is designed for

- Complete, immutable document revisions.
- Stable identities for documents and revisions.
- Explicit ancestry between versions.
- Archive and restore without deleting history.
- Compact storage of content shared across revisions.
- Recovery to the last complete save after an interrupted write.

This model is useful for content systems, editors, configuration stores, and
other applications that need reliable history without building versioning as a
separate layer.

## Oddo values

odbx documents are composed from Oddo `Record` and `Tuple` values:

```js
import { Record, Tuple } from 'odbx';

const tags = Tuple('database', 'javascript');

const original = Record({
  title: 'Introducing odbx',
  tags,
});

const edited = Record({
  ...original,
  title: 'Introducing Oddo DB',
});

edited.tags === original.tags; // true: unchanged content is shared
Record({ tags, title: 'Introducing odbx' }) === original; // true
```

Tuples preserve order. Records represent unordered fields, so constructing the
same Record in a different key order produces the same canonical value.

## Availability

odbx is an early development preview and is not ready for production use. The
public package currently exposes `Record` and `Tuple`; the document database API
is still being completed.

odbx requires Node.js 22 or later and uses ES modules.

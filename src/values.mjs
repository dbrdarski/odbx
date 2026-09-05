// ==========================================
// Unified Structural Interning Engine
// ==========================================

// The interner never creates a value it returns. It only decides which
// already-created reference is the canonical one: on a hit the given value
// is discarded, on a miss it becomes canonical. Values enter
// one level at a time - children must already be interned (or primitive)
// before their container is constructed, so no walk ever recurses.

export function extendFn(fn, parent) {
  fn.prototype = Object.create(parent.prototype);
  fn.prototype.constructor = fn;
  Object.setPrototypeOf(fn, parent);
  return fn
}

const isReferential = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');

const createNode = () => ({
  primitives: new Map(),
  objects: new WeakMap(),
  ref: null
});

const root = createNode();

// A finalizer may fire late: its value died, but an equal construction may
// already occupy the slot. Clear only when the current ref is actually dead,
// so a stale finalizer can never evict a live canonical.
const finalizer = new FinalizationRegistry((leaf) => {
  leaf.ref?.deref() ?? (leaf.ref = null);
});

const step = (current, item) => {
  const map = isReferential(item) ? current.objects : current.primitives;
  let next = map.get(item);
  if (!next) {
    next = createNode();
    map.set(item, next);
  }
  return next;
};

export const canonical = (tag, parts, value) => {
  let current = step(root, tag);
  for (const part of parts) {
    current = step(current, part);
  }

  if (current.ref) {
    const cached = current.ref.deref();
    if (cached) return cached;
  }

  current.ref = new WeakRef(value);
  finalizer.register(value, current);

  return value;
};

export const Tuple = extendFn(function Tuple(...args) {
  const tuple = args.length === 1
    ? Reflect.construct(Array, [], Tuple)
    : Reflect.construct(Array, args, Tuple)

  if (args.length === 1) tuple[0] = args[0]

  return canonical(Tuple, args, tuple)
}, Array)

export const Record = extendFn(function Record(props) {
  const record = Object.create(Record.prototype);
  const parts = [];

  if (props != null) {
    const keys = Object.keys(props).sort();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const val = props[key]
      parts.push(key, val)
      if (key === '__proto__')
        Object.defineProperty(record, key, {
          value: val,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      else
        record[key] = val
    }
  }

  return canonical(Record, parts, record);
}, Object)

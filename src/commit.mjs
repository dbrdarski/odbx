import { getKey, rollback } from './stores.mjs';

export async function commit(stores, write, value) {
  const transaction = { ...stores, counters: new Map(Object.values(stores).map(store => [store, store.counter.fork()])), created: [], output: [] };
  try {
    const key = getKey(transaction, value);
    await write(Buffer.from(transaction.output.join('')));
    for (const [store, counter] of transaction.counters) store.counter = counter;
    return key;
  } catch (error) {
    rollback(transaction.created);
    throw error;
  }
}

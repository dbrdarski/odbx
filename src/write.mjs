import { getKey, rollback } from './stores.mjs';

export function createWrite(stores, adapter, discover = getKey, committedEndOffset = 0) {
  let pending = Promise.resolve();
  let recoveryFailure;

  return value => {
    const result = pending.then(async () => {
      if (recoveryFailure) throw recoveryFailure;
      const transaction = {
        ...stores,
        counters: new Map(Object.values(stores).map(store => [store, store.counter.fork()])),
        output: [],
        created: [],
      };
      const startOffset = committedEndOffset;
      let appending = false;
      try {
        const key = discover(transaction, value);
        const bytes = Buffer.from(transaction.output.join(''), 'utf8');
        appending = true;
        await adapter.write(bytes);
        for (const [store, counter] of transaction.counters) store.counter = counter;
        committedEndOffset += bytes.length;
        return key;
      } catch (error) {
        rollback(transaction.created);
        if (appending) {
          try {
            await adapter.truncate(startOffset);
          } catch (cause) {
            recoveryFailure = new AggregateError([error, cause], 'Append and recovery both failed');
            throw recoveryFailure;
          }
        }
        throw error;
      }
    });
    pending = result.catch(() => {});
    return result;
  };
}

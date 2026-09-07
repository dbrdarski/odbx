export async function commit(stores, persist, discover) {
  const definitions = [], entries = [], restore = stores.map(store => store.transact());
  const write = (definition, value, keys) => {
    entries.push([keys, value]);
    definitions.push(definition);
  };
  try {
    const result = discover(write);
    await persist(definitions.join(""));
    return result;
  } catch (error) {
    for (const [keys, value] of entries) keys.delete(value);
    for (const rollback of restore) rollback();
    throw error;
  }
}

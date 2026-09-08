import { open } from "node:fs/promises";
import { createStores } from "./stores.mjs";
import { createWriter } from "./writer.mjs";

const createDatabase = file => {
  const stores = createStores();
  const write = createWriter(stores, file);

  return {
    addDocumentType: stores.addDocumentType,
    save(document, options) {
      const revision = stores.createRevision(document, options);
      return write(revision).then(() => revision);
    },
    close: () => file.close(),
  };
};

export const DB = {
  create: async filename => createDatabase(await open(filename, "wx+")),
};

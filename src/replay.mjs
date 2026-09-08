import { parse } from "./parser.mjs";

export const replay = (stores, bytes) => stores.matchTokens(parse(bytes));

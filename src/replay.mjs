import { parse } from "./parser.mjs";

export const replay = (stores, bytes, publish) => stores.matchTokens(parse(bytes), publish);

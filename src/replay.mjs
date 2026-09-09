import { parse, ParseError } from "./parser.mjs";

const boundary = bytes => {
  const replayed = { endOffset: 0 };
  try {
    for (const token of parse(bytes)) {
      if (token.type === "revision") replayed.endOffset = token.endOffset;
    }
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
  }
  return replayed.endOffset;
};

export const replay = (stores, bytes, publish) => {
  const endOffset = boundary(bytes);
  stores.matchTokens(parse(bytes.subarray(0, endOffset)), publish);
  return endOffset;
};

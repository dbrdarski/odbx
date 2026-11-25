import { parse, ParseError } from "./parser.mjs";

const boundary = bytes => {
  const replayed = { endOffset: 0 };
  try {
    for (const token of parse(bytes)) {
      if (token.type === "revision" || token.type === "fork") replayed.endOffset = token.endOffset;
    }
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
  }
  return replayed.endOffset;
};

function* throughFork({ bytes, identifier }) {
  let numbered = 0;
  for (const token of parse(bytes)) {
    yield token;
    if (token.type !== "fork") continue;
    const child = token.name === null ? numbered++ : token.name;
    if (child === identifier) return;
  }
  throw Error(`Unknown fork: ${identifier}`);
}

export const replay = (stores, bytes, publish, steps = [], onFork = () => {}) => {
  const endOffset = boundary(bytes);
  function* tokens() {
    for (const step of steps) yield* throughFork(step);
    for (const token of parse(bytes.subarray(0, endOffset))) {
      if (token.type === "fork") onFork(token);
      yield token;
    }
  }
  stores.matchTokens(tokens(), publish);
  return endOffset;
};

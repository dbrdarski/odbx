import { encodeInt } from './codec.mjs';

const reference = type => id => {
  const token = `${type}${encodeInt(id)}`;
  return Object.freeze({ type, id, toString: () => token });
};

export const stringReference = reference('S');
export const tupleReference = reference('A');
export const recordReference = reference('O');

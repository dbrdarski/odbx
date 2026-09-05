import { encodeInt } from './codec.mjs';

const reference = type => id => `${type}${encodeInt(id)}`;

export const stringReference = reference('S');
export const tupleReference = reference('A');
export const recordReference = reference('O');
export const revisionReference = reference('R');

export const documentReference = typeId => id => `D${encodeInt(typeId)}:${encodeInt(id)}`;

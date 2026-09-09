const writeAll = async (file, bytes, position) => {
  const { bytesWritten } = await file.write(bytes, 0, bytes.length, position);
  if (!bytesWritten) throw Error("Unable to write transaction");
  return bytesWritten === bytes.length
    ? position + bytesWritten
    : writeAll(file, bytes.subarray(bytesWritten), position + bytesWritten);
};

export const persist = (file, payload, position) => writeAll(file, Buffer.from(payload), position);

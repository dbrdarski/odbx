export async function persist(file, payload) {
  const bytes = Buffer.from(payload), { size } = await file.stat();
  try {
    await file.appendFile(bytes);
  } catch (error) {
    await file.truncate(size);
    throw error;
  }
}

/**
 * Read iterable parsed json of JSON Lines.
 *
 * @param reader
 * @param decoder
 */
export async function* readJsonlStream<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder
): AsyncGenerator<T> {
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
  }

  if (buffer.trim()) yield JSON.parse(buffer);
}

/**
 * Read iterable parsed list
 *
 * @param reader
 * @param decoder
 */
export async function* readListStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder
): AsyncGenerator<string> {
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) yield line;
    }
  }

  if (buffer.trim()) yield buffer;
}

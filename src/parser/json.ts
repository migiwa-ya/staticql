/**
 * Parses a JSON string or buffer and returns the corresponding object.
 *
 * Automatically decodes a Uint8Array using UTF-8 if needed.
 *
 * @param rawContent - Raw JSON content as string or binary (Uint8Array).
 * @returns Parsed JSON object.
 * @throws If the input is not valid JSON.
 */
export function parseJSON({ rawContent }: { rawContent: string | Uint8Array }) {
  return JSON.parse(
    typeof rawContent === "string"
      ? rawContent
      : new TextDecoder().decode(rawContent)
  );
}

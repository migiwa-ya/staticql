export function parseJSON({ rawContent }: { rawContent: string }) {
  return JSON.parse(
    typeof rawContent === "string"
      ? rawContent
      : new TextDecoder().decode(rawContent)
  );
}

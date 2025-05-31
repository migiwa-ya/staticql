import { parseYAML } from "./yaml.js";

/**
 * parseMarkdown: Parses a Markdown string with optional YAML frontmatter.
 *
 * Extracts frontmatter (delimited by `---`) as metadata, and returns both attributes and content body.
 *
 * @param rawContent - The raw Markdown string to parse.
 * @returns An object containing parsed frontmatter fields and the remaining Markdown body as `content`.
 */
export function parseMarkdown({ rawContent }: { rawContent: string }) {
  const frontmatterMatch = rawContent.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  let attributes: Record<string, any> = {};
  let body = rawContent;

  if (frontmatterMatch) {
    const parsed = parseYAML({ rawContent: frontmatterMatch[1] });

    // If the frontmatter is an array, use the first item as attributes
    attributes = Array.isArray(parsed) ? parsed[0] : parsed;
  }

  return attributes;
}

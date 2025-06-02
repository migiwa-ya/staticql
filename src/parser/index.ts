import { parseFrontMatter } from "./frontMatter.js";
import { parseYAML } from "./yaml.js";
import { parseJSON } from "./json.js";

/**
 * Union type for parsed content.
 */
export type ParsedData = unknown;

/**
 * Options for all parsers.
 */
export interface ParserOptions {
  /**
   * Raw file content as a string or binary buffer.
   */
  rawContent: string | Uint8Array;
}

/**
 * parseByType: Delegates parsing based on declared content type.
 *
 * Supports:
 * - `"markdown"` → parses frontmatter and body
 * - `"yaml"` → parses indentation-based YAML
 * - `"json"` → parses standard JSON
 *
 * @param type - The declared type of the content (`markdown`, `yaml`, or `json`)
 * @param options - Contains the raw content to parse
 * @returns The parsed result as a plain object (or array)
 * @throws If the type is not supported or parsing fails
 */
export async function parseByType(
  type: "markdown" | "yaml" | "json",
  options: ParserOptions
): Promise<any> {
  let rawContent: string;
  if (options.rawContent instanceof Uint8Array) {
    rawContent = new TextDecoder().decode(options.rawContent);
  } else {
    rawContent = options.rawContent;
  }

  switch (type) {
    case "markdown":
      return parseFrontMatter({ rawContent });
    case "yaml":
      return parseYAML({ rawContent });
    case "json":
      return parseJSON({ rawContent });
    default:
      throw new Error(`Unsupported parser type: ${type}`);
  }
}

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
/**
 * Parser function type.
 * Accepts ParserOptions and returns parsed data (sync or async).
 */
export type Parser = (options: ParserOptions) => any;

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
 * Built-in parser registry. Keys are format types.
 */
export const defaultParsers: Record<string, Parser> = {
  markdown: ({ rawContent }) => {
    const text = rawContent instanceof Uint8Array ? new TextDecoder().decode(rawContent) : rawContent;
    return parseFrontMatter({ rawContent: text });
  },
  yaml: ({ rawContent }) => {
    const text = rawContent instanceof Uint8Array ? new TextDecoder().decode(rawContent) : rawContent;
    return parseYAML({ rawContent: text });
  },
  json: ({ rawContent }) => {
    const text = rawContent instanceof Uint8Array ? new TextDecoder().decode(rawContent) : rawContent;
    return parseJSON({ rawContent: text });
  },
};

/**
 * Register or override a parser for a given type.
 */
export function registerParser(type: string, parser: Parser): void {
  defaultParsers[type] = parser;
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
/**
 * parseByType: Delegates parsing based on declared content type, using registered parsers.
 *
 * You can inject or override parsers via `parserRegistry` before invoking.
 */
export async function parseByType(
  type: string,
  options: ParserOptions
): Promise<any> {
  let rawContent: string;
  if (options.rawContent instanceof Uint8Array) {
    rawContent = new TextDecoder().decode(options.rawContent);
  } else {
    rawContent = options.rawContent;
  }

  const parser = defaultParsers[type];
  if (!parser) {
    throw new Error(`No parser registered for type: ${type}`);
  }
  return parser({ rawContent });
}

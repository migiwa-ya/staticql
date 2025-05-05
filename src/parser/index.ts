import { parseMarkdown } from "./markdown.js";
import { parseYAML } from "./yaml.js";
import { parseJSON } from "./json.js";

export type ParsedData = unknown;

export interface ParserOptions {
  rawContent: string | Uint8Array;
}

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
      return parseMarkdown({ rawContent });
    case "yaml":
      return parseYAML({ rawContent });
    case "json":
      return parseJSON({ rawContent });
    default:
      throw new Error(`Unsupported parser type: ${type}`);
  }
}

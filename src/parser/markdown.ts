import { parseYAML } from "./yaml.js";

/**
 * 簡易Markdownパーサー: frontmatter（YAML）を抽出し、bodyとattributesを返す
 */
export function parseMarkdown({ rawContent }: { rawContent: string }) {
  const frontmatterMatch = rawContent.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  let attributes: Record<string, any> = {};
  let body = rawContent;

  if (frontmatterMatch) {
    const parsed = parseYAML({ rawContent: frontmatterMatch[1] });

    // YAMLが配列の場合は最初の要素をattributesとする
    attributes = Array.isArray(parsed) ? parsed[0] : parsed;
    body = rawContent.slice(frontmatterMatch[0].length);
  }

  return { ...attributes, content: body };
}

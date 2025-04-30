/**
 * 簡易Markdownパーサー: frontmatter（YAML）を抽出し、bodyとattributesを返す
 */
export function parseMarkdown(input: string): {
  body: string;
  attributes: Record<string, any>;
} {
  const frontmatterMatch = input.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  let attributes: Record<string, any> = {};
  let body = input;

  if (frontmatterMatch) {
    const parsed = parseYAML(frontmatterMatch[1]);
    // YAMLが配列の場合は最初の要素をattributesとする
    attributes = Array.isArray(parsed) ? parsed[0] : parsed;
    body = input.slice(frontmatterMatch[0].length);
  }

  return { attributes, body };
}

/**
 * インデントベースの簡易YAMLパーサー
 */
export function parseYAML(input: string): any {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  let idx = 0;

  function parseBlock(indent = 0): any {
    const result: any = {};
    let arr: any[] | null = null;

    while (idx < lines.length) {
      let line = lines[idx];
      if (!line.trim() || line.trim().startsWith("#")) {
        idx++;
        continue;
      }

      const currentIndent = line.match(/^(\s*)/)![1].length;
      if (currentIndent < indent) break;

      if (line.trim().startsWith("- ")) {
        if (!arr) arr = [];
        // 配列要素の先頭
        let itemLine = line.slice(line.indexOf("- ") + 2);

        // オブジェクト形式か単一値か判定
        if (itemLine.includes(":")) {
          // - key: value ... の場合
          const [firstKey, ...rest] = itemLine.split(":");
          const firstValue = rest.join(":").trim();
          const obj: any = {};
          obj[firstKey.trim()] = parseValue(firstValue);
          idx++;
          // ネストが続く場合
          const child = parseBlock(currentIndent + 2);
          Object.assign(obj, child);
          arr.push(obj);
        } else {
          // - value の場合
          arr.push(parseValue(itemLine.trim()));
          idx++;
        }
      } else if (line.includes(":")) {
        // key: value
        const [key, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        idx++;

        if (lines[idx]) {
          const match = lines[idx].match(/^(\s*)/);

          if (match && match[1].length > currentIndent) {
            // ネストオブジェクト
            const child = parseBlock(currentIndent + 2);
            result[key.trim()] = Object.keys(child).length
              ? child
              : parseValue(value);
          } else {
            result[key.trim()] = parseValue(value);
          }
        } else {
          result[key.trim()] = parseValue(value);
        }
      } else {
        idx++;
      }
    }

    return arr ? arr : result;
  }

  function parseValue(val: string): any {
    if (val === "true") return true;
    if (val === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
    // インライン配列表記 [a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      // [a, b, c] → ["a", "b", "c"]
      return val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
    }

    return val;
  }

  const parsed = parseBlock(0);

  // ルートが配列の場合はそのまま返す
  if (Array.isArray(parsed)) return parsed;

  return parsed;
}

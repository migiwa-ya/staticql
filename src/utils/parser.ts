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

  // 先頭の空行・コメント行をスキップ
  while (
    idx < lines.length &&
    (!lines[idx].trim() || lines[idx].trim().startsWith("#"))
  ) {
    idx++;
  }

  // ルートが配列の場合は専用パーサー
  if (lines[idx] && lines[idx].trim().startsWith("- ")) {
    return parseArrayBlock(0);
  }

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

      // インライン配列の複数行対応
      if (line.includes(":")) {
        const [key, ...rest] = line.split(":");
        let value = rest.join(":").trim();
        idx++;

        // [ で始まるが ] で終わらない場合、次の行以降を結合
        if (value.startsWith("[") && !value.endsWith("]")) {
          let arrLines = [value];
          while (idx < lines.length) {
            const l = lines[idx].trim();
            arrLines.push(l);
            idx++;
            if (l.endsWith("]")) break;
          }
          // 改行・余計な空白を除去して1行に
          value = arrLines.join(" ").replace(/\s+/g, " ");
        }

        if (lines[idx]) {
          const match = lines[idx].match(/^(\s*)/);
          // ネスト配列対応: key: の値が空で、次の行がインデント増かつ - で始まる場合
          if (
            value === "" &&
            match &&
            match[1].length > currentIndent &&
            lines[idx].trim().startsWith("- ")
          ) {
            // ネスト配列
            result[key.trim()] = parseArrayBlock(currentIndent + 2);
          }
          // 複数行インライン配列対応: key: の値が空で、次の行がインデント増かつ [ で始まる場合
          else if (
            value === "" &&
            match &&
            match[1].length > currentIndent &&
            lines[idx].trim().startsWith("[")
          ) {
            // 複数行インライン配列
            let arrLines = [];
            while (idx < lines.length) {
              const l = lines[idx].trim();
              arrLines.push(l);
              idx++;
              if (l.endsWith("]")) break;
            }
            const arrValue = arrLines.join(" ").replace(/\s+/g, " ");
            result[key.trim()] = parseValue(arrValue);
          } else if (match && match[1].length > currentIndent) {
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
      } else if (line.trim().startsWith("- ")) {
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
      } else {
        idx++;
      }
    }

    // 配列として返すべきか判定
    if (arr && arr.length > 0) return arr;
    // ルートが空配列の場合も配列で返す
    if (arr && arr.length === 0 && indent === 0) return [];
    return result;
  }

  // ルートが配列の場合の専用パーサー
  function parseArrayBlock(indent = 0): any[] {
    const arr: any[] = [];
    while (idx < lines.length) {
      let line = lines[idx];
      if (!line.trim() || line.trim().startsWith("#")) {
        idx++;
        continue;
      }
      const currentIndent = line.match(/^(\s*)/)![1].length;
      if (currentIndent < indent) break;
      if (line.trim().startsWith("- ")) {
        let itemLine = line.slice(line.indexOf("- ") + 2);
        if (itemLine.includes(":")) {
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
          arr.push(parseValue(itemLine.trim()));
          idx++;
        }
      } else {
        break;
      }
    }
    return arr;
  }

  function parseValue(val: string): any {
    if (val === "true") return true;

    if (val === "false") return false;

    if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);

    // インライン配列表記 [a, b, c]（複数行対応・空白/カンマ/クォート除去）
    if (val.startsWith("[") && val.endsWith("]")) {
      return val
        .slice(1, -1)
        .split(",")
        .map(
          (s) => s.replace(/^[\s'"]+|[\s'",]+$/g, "") // 先頭・末尾の空白・クォート・カンマを除去
        )
        .filter((s) => s.length > 0);
    }

    // ISO8601日時→Date型
    if (
      typeof val === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        val
      )
    ) {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d;
    }

    return val;
  }

  const parsed = parseBlock(0);

  // ルートが配列の場合はそのまま返す
  if (Array.isArray(parsed)) return parsed;

  return parsed;
}

/**
 * parseYAML: A minimal YAML parser based on indentation.
 *
 * - Supports nested objects and arrays.
 * - Handles inline arrays (`[a, b, c]`), multi-line arrays, booleans, numbers, and ISO date strings.
 * - Does not support advanced YAML features (anchors, multi-docs, etc.).
 *
 * @param rawContent - Raw YAML string content.
 * @returns Parsed JavaScript object or array.
 */
export function parseYAML({ rawContent }: { rawContent: string }): any {
  const lines = rawContent.replace(/\r\n/g, "\n").split("\n");
  let idx = 0;

  // Skip initial blank lines or comments
  while (
    idx < lines.length &&
    (!lines[idx].trim() || lines[idx].trim().startsWith("#"))
  ) {
    idx++;
  }

  // Root-level array
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

      if (line.includes(":")) {
        const [key, ...rest] = line.split(":");
        let value = rest.join(":").trim();
        idx++;

        // Multi-line inline array
        if (value.startsWith("[") && !value.endsWith("]")) {
          let arrLines = [value];
          while (idx < lines.length) {
            const l = lines[idx].trim();
            arrLines.push(l);
            idx++;
            if (l.endsWith("]")) break;
          }
          value = arrLines.join(" ").replace(/\s+/g, " ");
        }

        const nextLine = lines[idx];
        const match = nextLine?.match(/^(\s*)/);

        if (
          value === "" &&
          match &&
          match[1].length > currentIndent &&
          nextLine.trim().startsWith("- ")
        ) {
          // Nested array
          result[key.trim()] = parseArrayBlock(currentIndent + 2);
        } else if (
          value === "" &&
          match &&
          match[1].length > currentIndent &&
          nextLine.trim().startsWith("[")
        ) {
          // Multi-line inline array
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
          const child = parseBlock(currentIndent + 2);
          result[key.trim()] = Object.keys(child).length
            ? child
            : parseValue(value);
        } else {
          result[key.trim()] = parseValue(value);
        }
      } else if (line.trim().startsWith("- ")) {
        if (!arr) arr = [];
        let itemLine = line.slice(line.indexOf("- ") + 2);

        if (itemLine.includes(":")) {
          const [firstKey, ...rest] = itemLine.split(":");
          const firstValue = rest.join(":").trim();
          const obj: any = {};
          obj[firstKey.trim()] = parseValue(firstValue);
          idx++;
          const child = parseBlock(currentIndent + 2);
          Object.assign(obj, child);
          arr.push(obj);
        } else {
          arr.push(parseValue(itemLine.trim()));
          idx++;
        }
      } else {
        idx++;
      }
    }

    if (arr && arr.length > 0) return arr;
    if (arr && arr.length === 0 && indent === 0) return [];
    return result;
  }

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

    if (val.startsWith("[") && val.endsWith("]")) {
      return val
        .slice(1, -1)
        .split(",")
        .map((s) => s.replace(/^[\s'"]+|[\s'",]+$/g, ""))
        .filter((s) => s.length > 0);
    }

    if (val === 'null') return null;

    if (val === '') return undefined;

    return val;
  }

  const parsed = parseBlock(0);
  return parsed;
}

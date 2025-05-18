export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string;
  endCursor?: string;
}

export type CursorObject = { slug: string; order: { [key: string]: string } };

/**
 * Create PageInfo.
 *
 * @param page
 * @param pageSize
 * @param startIndex
 * @param matchedLen
 * @param direction
 * @param encodeCursor
 * @returns page info for cursor pagination
 */
export function createPageInfo<T>(
  page: T[],
  pageSize: number,
  startIndex: number,
  matchedLen: number,
  direction: "after" | "before",
  encodeCursor: (item: T) => string
): PageInfo {
  let hasNextPage = false;
  let hasPreviousPage = false;

  if (direction === "after") {
    hasNextPage = startIndex + (startIndex > 0 ? 1 : 0) + pageSize < matchedLen;
    hasPreviousPage = startIndex + (startIndex > 0 ? 1 : 0) > 0;
  } else {
    const endIdx = startIndex;
    const beginIdx = Math.max(0, endIdx - pageSize);
    hasNextPage = endIdx < matchedLen;
    hasPreviousPage = beginIdx > 0;
  }

  return {
    hasNextPage,
    hasPreviousPage,
    startCursor: page.length > 0 ? encodeCursor(page[0]) : undefined,
    endCursor:
      page.length > 0 ? encodeCursor(page[page.length - 1]) : undefined,
  };
}

/**
 * Get sliced records.
 *
 * @param records
 * @param startIndex
 * @param pageSize
 * @param direction
 * @returns
 */
export function getPageSlice<T>(
  records: T[],
  startIndex: number,
  pageSize: number,
  direction: "after" | "before"
): T[] {
  if (direction === "after") {
    return records.slice(
      startIndex + (startIndex > 0 ? 1 : 0),
      startIndex + (startIndex > 0 ? 1 : 0) + pageSize
    );
  } else {
    const endIdx = startIndex;
    const beginIdx = Math.max(0, endIdx - pageSize);
    return records.slice(beginIdx, endIdx);
  }
}

/**
 * Encode for cursor.
 *
 * @param slug
 * @returns
 */
export function encodeCursor(obj: CursorObject): string {
  const str = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Decode for cursor.
 *
 * @param cursor
 * @returns
 */
export function decodeCursor(cursor: string): CursorObject {
  try {
    const binary = atob(cursor);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj;
  } catch {
    throw new Error("Invalid cursor");
  }
}

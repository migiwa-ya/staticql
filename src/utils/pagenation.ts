export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string;
  endCursor?: string;
  total: number;
}

/**
 * Create PageInfo.
 *
 * @param total
 * @param page
 * @param pageSize
 * @param startIdx
 * @param matchedLen
 * @param direction
 * @param encodeCursor
 * @returns page info for cursor pagination
 */
export function createPageInfo<T>(
  total: number,
  page: T[],
  pageSize: number,
  startIdx: number,
  matchedLen: number,
  direction: "after" | "before",
  encodeCursor: (item: T) => string
): PageInfo {
  let hasNextPage = false;
  let hasPreviousPage = false;

  if (direction === "after") {
    hasNextPage = startIdx + (startIdx > 0 ? 1 : 0) + pageSize < matchedLen;
    hasPreviousPage = startIdx + (startIdx > 0 ? 1 : 0) > 0;
  } else {
    const endIdx = startIdx;
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
    total,
  };
}

/**
 * Get sliced records.
 *
 * @param records
 * @param startIdx
 * @param pageSize
 * @param direction
 * @returns
 */
export function getPageSlice<T>(
  records: T[],
  startIdx: number,
  pageSize: number,
  direction: "after" | "before"
): T[] {
  if (direction === "after") {
    return records.slice(
      startIdx + (startIdx > 0 ? 1 : 0),
      startIdx + (startIdx > 0 ? 1 : 0) + pageSize
    );
  } else {
    const endIdx = startIdx;
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
export function encodeCursor(slug: string): string {
  const str = JSON.stringify({ slug });
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
export function decodeCursor(cursor: string): string {
  try {
    const binary = atob(cursor);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj.slug;
  } catch {
    throw new Error("Invalid cursor");
  }
}

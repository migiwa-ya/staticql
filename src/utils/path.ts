/**
 * Get parent path from path string.
 *
 * @param currentPath
 * @returns
 */
export function toParent(currentPath: string) {
  const path = trimSlash(currentPath);

  return path.substring(0, path.lastIndexOf("/"));
}

/**
 * Trim end specific string
 *
 * @param
 * @returns
 */
export function trimSlash(path: string): string {
  while (path.endsWith("/")) {
    path = path.slice(0, -"/".length);
  }

  return path;
}

/**
 * Join all path parts with "/" and remove duplicate slashes.
 *
 * @param parts 
 * @returns 
 */
export function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/**
 * Create a path for an index file (_index.jsonl) from path parts. 
 *
 * @param path 
 * @returns 
 */
export function toI(...path: string[]): string {
  return joinPath(...path, "_index.jsonl");
}

/**
 * Create a path for a prefixes file (_prefixes.jsonl) from path parts.
 * 
 * @param path 
 * @returns 
 */
export function toP(...path: string[]): string {
  return joinPath(...path, "_prefixes.jsonl");
}

/**
 * Split the path into base directory and the last segment (tail).
 *
 * @param path 
 * @returns 
 */
export function tail(path: string) {
  const p = path.split("/");
  const l = p.length;

  return { base: joinPath(...p.slice(0, l - 1)), tail: p[l - 1] };
}

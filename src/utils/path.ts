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

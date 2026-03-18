import type { StaticQL } from "./StaticQL.js";
import type { SourceRecord } from "./types.js";
import type { PageResult } from "./QueryBuilder.js";

/**
 * Result of a static query extraction.
 */
export interface StaticQueryResult<T> {
  data: T[];
  pageInfo: PageResult<T>["pageInfo"];
  generatedAt: string;
}

/**
 * Executes a StaticQL query and returns the result as a JSON-serializable object.
 *
 * Designed for SSG/SSR build-time usage: run queries during the build step
 * and output the results as static JSON files that clients can fetch directly.
 *
 * Usage with Astro:
 * ```ts
 * // src/pages/api/herbs.json.ts
 * import { staticQuery } from "staticql/ssg";
 *
 * export async function GET() {
 *   const result = await staticQuery(staticql, (sq) =>
 *     sq.from<HerbsRecord>("herbs").orderBy("name").pageSize(100).exec()
 *   );
 *   return new Response(JSON.stringify(result));
 * }
 * ```
 *
 * Usage with Node.js (write to file):
 * ```ts
 * import { staticQuery } from "staticql/ssg";
 * import fs from "fs";
 *
 * const result = await staticQuery(staticql, (sq) =>
 *   sq.from<HerbsRecord>("herbs").exec()
 * );
 * fs.writeFileSync("public/api/herbs.json", JSON.stringify(result));
 * ```
 *
 * @param staticql - A StaticQL instance.
 * @param queryFn - A function that receives the StaticQL instance and returns a query result.
 * @returns The query result with metadata.
 */
export async function staticQuery<T extends SourceRecord>(
  staticql: StaticQL,
  queryFn: (sq: StaticQL) => Promise<PageResult<T>>
): Promise<StaticQueryResult<T>> {
  const result = await queryFn(staticql);
  return {
    data: result.data,
    pageInfo: result.pageInfo,
    generatedAt: new Date().toISOString(),
  };
}

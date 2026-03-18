# StaticQL

**StaticQL** (Static File Query Layer) is a query engine for structured static content — Markdown, YAML, JSON, and more.

Define your data sources as plain files, build search indexes, and run type-safe queries with joins, sorting, and cursor-based pagination. No server required. Deploy your data to a CDN and query it directly from the browser.

## What is this for?

StaticQL works best when your content lives in Git as human-readable files and you want to search, filter, and traverse relationships — all without a backend.

Think of it as a query engine for a headless CMS where the "database" is your file system and the "server" is a CDN.

**Good fit:**
- Knowledge bases and reference sites (e.g. herbal databases, technical wikis)
- Regional or facility directories (e.g. shrine archives, shop listings)
- Documentation sites with structured metadata
- Open data projects where datasets are maintained on GitHub

**Not the right tool for:**
- Analytics or aggregation queries (GROUP BY, SUM) — consider SQLite Wasm or DuckDB
- User-generated content that requires write operations
- Datasets with 100k+ records

### Why not SQLite Wasm?

SQLite Wasm and DuckDB Wasm are powerful alternatives for client-side querying. The key difference is in the data lifecycle:

- **StaticQL** — your content files _are_ the data source. Markdown frontmatter, YAML, JSON — all directly queryable. Changes go through Git: PRs, diff reviews, CI validation. Non-engineers can contribute with a text editor.
- **SQLite/DuckDB** — requires an ETL step to convert files into a binary database. Git diffs become meaningless. You end up maintaining both the source files and the database.

If your data is already tabular and you need SQL's full power, use SQLite Wasm. If your data is content-first and Git-managed, StaticQL fits naturally.

## Features

- **Indexed Filtering** — `eq`, `startsWith`, `in` operators on fields and relations
- **Relations & Joins** — `hasOne`, `hasMany`, `belongsTo`, `hasManyThrough`, `hasOneThrough`
- **Ordering & Pagination** — cursor-based pagination with configurable page size
- **Multiple Runtimes** — works in Node.js, browsers, and Cloudflare Workers
- **Multiple Storage Backends** — local filesystem, HTTP/CDN fetch, Cloudflare R2
- **CLI Tools** — index generation (full & incremental) and TypeScript type generation
- **Type-Safe API** — full TypeScript inference from your config
- **Parser Injection** — extend with custom parsers (CSV, XML, etc.)

## Installation

```bash
npm install staticql
```

## Configuration

Create a `staticql.config.json` to declare your data sources and indexes.

```jsonc
{
  "sources": {
    "herbs": {
      "type": "markdown",
      "pattern": "content/herbs/*.md",
      "schema": {
        /* JSON Schema */
      },
      "relations": {
        /* hasMany, hasOneThrough, etc. */
      },
      "index": {
        "slug": {},
        "name": {},
        "tagSlugs": {}
      }
    }
  }
}
```

## Usage

### Initialize StaticQL

```ts
import { defineStaticQL, StaticQLConfig } from "staticql";
import { FsRepository } from "staticql/repo/fs";
import config from "./staticql.config.json";
import type { HerbsRecord, RecipesRecord } from "./staticql-types";

const staticql = defineStaticQL(config as StaticQLConfig)({
  repository: new FsRepository("./"),
});

// Generate indexes (required before queries)
await staticql.saveIndexes();
```

For browser / CDN usage:

```ts
import { FetchRepository } from "staticql/repo/fetch";

const staticql = defineStaticQL(config as StaticQLConfig)({
  repository: new FetchRepository("https://cdn.example.com/"),
});
```

### Querying & Joining

```ts
// Simple indexed filter
const { data: herbs } = await staticql
  .from<HerbsRecord>("herbs")
  .where("slug", "eq", "arctium-lappa")
  .exec();

// Join and filter on related source
const { data: recipes } = await staticql
  .from<RecipesRecord>("recipes")
  .join("herbs")
  .where("herbs.slug", "in", ["centella-asiatica"])
  .orderBy("name", "asc")
  .pageSize(10)
  .exec();
```

### Pagination

```ts
// First page
const firstPage = await staticql
  .from<HerbsRecord>("herbs")
  .orderBy("name")
  .pageSize(2)
  .exec();

// Next page using cursor
const nextPage = await staticql
  .from<HerbsRecord>("herbs")
  .orderBy("name")
  .pageSize(2)
  .cursor(firstPage.pageInfo.endCursor)
  .exec();
```

## CLI

### Generate TypeScript Types

```bash
npx staticql-gen-types path/to/staticql.config.json output/dir
```

### Generate Indexes

```bash
npx staticql-gen-index path/to/staticql.config.json output/dir
```

Incremental updates from a diff file:

```bash
npx staticql-gen-index path/to/staticql.config.json output/dir \
  --incremental \
  --diff-file=changes.json
```

## Parser Injection

You can inject custom parsers when initializing StaticQL to handle arbitrary file formats, for example CSV:

```ts
import { defineStaticQL } from "staticql";
import { FsRepository } from "staticql/repo/fs";
import config from "./staticql.config.json";

const csvParser = ({ rawContent }) => {
  const text =
    rawContent instanceof Uint8Array
      ? new TextDecoder().decode(rawContent)
      : rawContent;
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
  const headers = lines[0];

  return lines.slice(1).map((cols) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, i) => {
      obj[header] = cols[i];
    });
    return obj;
  });
};

const staticql = defineStaticQL(config)({
  repository: new FsRepository("./"),
  options: { parsers: { csv: csvParser } },
});

await staticql.saveIndexes();
```

## Documentation

For detailed guides on configuration, performance tuning, and the full API, see the [Wiki](https://github.com/migiwa-ya/staticql/wiki).

## License

MIT

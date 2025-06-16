# StaticQL

**StaticQL** (Static File Query Layer) is a lightweight query engine for structured static content (Markdown, YAML, JSON).
It lets you define data sources, automatically build search indexes, and execute type-safe queries with joins, sorting, and cursor-based pagination.

## Features

- 🔍 **Indexed Filtering** (`eq`, `startsWith`, `in`) on fields and relations
- 🔗 **Relations & Joins** (`hasOne`, `hasMany`, `hasManyThrough`, `hasOneThrough`)
- 🔢 **Ordering & Pagination** with cursor support
- 🌐 **CLI Tools** for index and type generation
- 🔧 **Type-Safe API** with full TypeScript inference

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
      "schema": { /* JSON Schema */ },
      "relations": { /* hasMany, hasOneThrough, etc. */ },
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

```bash
npx staticql-gen-index path/to/staticql.config.json output/dir \
  --incremental \
  --diff-file=changes.json
```

## Development & Testing

```bash
npm ci
npm run build
npm test
```

## License

MIT

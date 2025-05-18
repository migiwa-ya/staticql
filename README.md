# StaticQL

**StaticQL (Static File Query Layer)** is a lightweight static data layer that allows you to query and join Markdown / YAML / JSON files directly. Queries are written using standard TypeScript syntax with full type inference support. While designed for small to medium-sized Jamstack and API projects, StaticQL is flexible enough to be used in a wide variety of contexts.

🇯🇵 日本語版はこちら → [README.ja.md](./README.ja.md)

## Features

- JSON Schema-based source definitions with lightweight validation
- Type-safe, cursor-based queries (where: eq, in, startsWith / join / orderBy / bidirectional pagination)
- Index file generation and usage for fast query performance
- Supports Node.js, browser, and Cloudflare Workers
- Works in Web UI by publishing schema, content, and index files

## Installation

```bash
npm install staticql
```

## Quick Start

```ts
import { defineStaticQL } from "staticql";
import { FsRepository } from "staticql/repo/fs";
import { HerbsRecord } from "./staticql-types";

const factory = defineStaticQL({
  sources: {
    herbs: {
      pattern: "content/herbs/*.md",
      type: "markdown",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          overview: { type: "string" },
        },
        required: ["name", "overview"],
      },
      index: ["name"],
    },
  },
});

const staticql = factory({ repository: new FsRepository("tests/") });

const result = await staticql
  .from<HerbsRecord>("herbs")
  .join("tags")
  .join("recipes")
  .where("name", "eq", "ラベンダー")
  .orderBy("name", "asc")
  .cursor(
    "eyJvcmRlciI6eyJuYW1lIjoiOGFjZi84YTJhIn0sInNsdWciOiJiZjk4ZDYxOS02Y2FhLTRlMDItOGMyMy00ZmFmMDE2OTMyZDAifQ==",
    "before"
  )
  .exec();

console.log(result);
```

**Each record's `slug` is automatically derived from the file name. You do not need to define it in the schema.**

## Generating TypeScript Definitions

You can generate `staticql-types.ts` from your schema definitions to enable IntelliSense and type-safe queries.

```bash
npx staticql-gen-types ./staticql.config.json ./
```

## Generating Index Files

To speed up queries, pre-generate index files using the following command. These indexes are used in `.where()` and `.join()` to avoid full scans.

### Full index generation

```bash
npx staticql-gen-index ./staticql.config.json ./public/index/
```

### Incremental index generation

```bash
npx staticql-gen-index ./staticql.config.json ./public/index/ --incremental --diff-file=./diff.json
```

#### Diff file format

Diff input is passed as a JSON array:

```json
[
  { "status": "A", "source": "herbs", "slug": "xxx" }
  { "status": "D", "source": "recipes", "slug": "yyy" }
]
```

- `status`: `"A"` = added, `"D"` = deleted
- `source`: Name of the updated source
- `slug`: Slug of the updated item

## Defining and Using Relations (`join`)

StaticQL supports relational joins between sources using `.join()`.

**Each record's `slug` is automatically derived from the file name and doesn't need to be included in the schema.**

### Example Content

#### `herbs/*.md`

```yaml
slug: peppermint
name: ペパーミント
herbStateSlug: dry
herbPartSlug: leaf
```

#### `herbStates.yaml`

```yaml
- slug: dry
  name: 乾燥
```

#### `herbParts.yaml`

```yaml
- slug: leaf
  name: 葉
```

### Configuration Example

```jsonc
// ./staticql.config.json
{
  "sources": {
    "herbs": {
      "pattern": "content/herbs/*.md",
      "type": "markdown",
      "schema": {
        /* omitted */
      },
      "relations": {
        "tags": {
          "to": "tags",
          "localKey": "tagSlugs",
          "foreignKey": "slug",
          "type": "hasMany"
        },
        "recipes": {
          "to": "recipes",
          "through": "recipeGroups",
          "sourceLocalKey": "slug",
          "throughForeignKey": "combinedHerbs.slug",
          "throughLocalKey": "slug",
          "targetForeignKey": "recipeGroupSlug",
          "type": "hasManyThrough"
        }
      }
    },
    "tags": {
      "path": "content/tags.yaml",
      "type": "yaml",
      "schema": {
        /* omitted */
      }
    },
    "recipeGroups": {
      "path": "content/recipeGroups/*.json",
      "type": "json",
      "schema": {
        /* omitted */
      }
    },
    "recipes": {
      "pattern": "content/recipes/*.md",
      "type": "markdown",
      "schema": {
        /* omitted */
      }
    }
  }
}
```

> Relation targets are automatically indexed; no need to include them in `index`.

### Query Example

```ts
import { defineStaticQL, StaticQLConfig } from "staticql";
import { FsRepository } from "staticql/repo/fs";
import { HerbsRecord } from "./staticql-types";

const raw = await fetch("http://127.0.0.1:8080/staticql.config.json");
const config = await raw.json();

const factory = defineStaticQL(config as StaticQLConfig);

const staticql = factory({
  repository: new FsRepository("tests/"),
});

const result = await staticql
  .from<HerbsRecord>("herbs")
  .where("name", "startsWith", "カモミール")
  .orderBy("name", "asc")
  .cursor(
    "eyJvcmRlciI6eyJuYW1lIjoiOGFjZi84YTJhIn0sInNsdWciOiJiZjk4ZDYxOS02Y2FhLTRlMDItOGMyMy00ZmFmMDE2OTMyZDAifQ==",
    "before"
  )
  .pageSize(5)

console.log(result);
/*
{
  data: [
    { id: 'bf98d619-6caa-4e02-8c23-4faf016932d0', name: 'カモミール・ローマン' },
    { id: 'd817025c-9254-4c4a-b167-3dbf056b9bad', name: 'カモミール・ジャーマン' },
    { id: 'a5de8a6e-80ad-4521-8260-b2e91d678841', name: 'カモミール・ワイルド' },
    { id: 'fdd52178-4f99-443a-bef3-52eb10b32dd6', name: 'カモミール・エジプト' },
    { id: '07dec3ee-7646-492e-95f6-18c46ae133b7', name: 'カモミール・ブルガリア' }
  ],
  pageInfo: {
    hasNextPage: true,
    hasPreviousPage: false,
    startCursor: 'eyJvcmRlciI6eyJuYW1lIjoiOGFjZi84YTJhIn0sInNsdWciOiJiZjk4ZDYxOS02Y2FhLTRlMDItOGMyMy00ZmFmMDE2OTMyZDAifQ==',
    endCursor: 'eyJvcmRlciI6eyJuYW1lIjoiOGFjZi84YTJhIn0sInNsdWciOiIwN2RlYzNlZS03NjQ2LTQ5MmUtOTVmNi0xOGM0NmFlMTMzYjcifQ=='
  }
}
*/
```

## Contact

For questions, feedback, or collaboration, feel free to reach out via:

- Blog: https://migiwa-ya.dev/about
- X: https://x.com/migiwa_ya_com
- GitHub Issues or Discussions

## License

MIT

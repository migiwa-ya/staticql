# staticql

staticql は、Markdown / YAML / JSON ファイルを型安全に読み込み、検索・結合できるシンプルなデータクエリエンジンです。小規模な構造化コンテンツを扱う Jamstack / SSG を想定しています。

## 特長

- Zod によるスキーマバリデーション
- SQL ライクなクエリ（where / join）
- CLI で index.json を出力可能

## インストール

```
npm install @migiwa-ya/staticql
```

## ディレクトリ例

```
project/
├── content/
│   ├── herbs/*.md
│   └── herbStates.yaml
├── public/
│   └── index/
├── staticql.config.ts
└── package.json
```

## staticql.config.ts の例

```ts
import { defineContentDB } from "@migiwa-ya/staticql";
import { z } from "zod";

export default defineContentDB({
  sources: {
    herbs: {
      path: "tests/content-fixtures/herbs/*.md",
      type: "markdown",
      schema: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
          herbStateSlug: z.string(),
        })
      ),
      relations: {
        herbState: {
          to: "herbStates",
          localKey: "herbStateSlug",
          foreignKey: "slug",
        },
      },
      index: ["name", "herbState.name", "tags"],
    },

    herbStates: {
      path: "tests/content-fixtures/herbStates.yaml",
      type: "yaml",
      schema: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
        })
      ),
    },
  },
});
```

## CLI の使い方

```bash
npx staticql-gen [configPath] [outputDir]
```

例：

```bash
npx staticql-gen staticql.config.ts public/index/
```

## Index/Meta File Structure

- 各 source ごとに、`index-{field}.json`（インデックスファイル）が出力されます。  
  例: `herbs.index-name.json` は name ごとの slug 配列を持ちます。
- `meta.json` ファイルは、meta: [] で指定した属性やリレーションの値を slug ごとにまとめて出力します。
- ドット記法（例: `"reports.reportGroupSlug"`）でリレーション先の属性も抽出できます。

## Meta Extraction (meta: [])

- `meta: []` を指定すると、各 source ごとに `{source}.meta.json` が出力されます。
- meta.json は slug ごとに、指定した属性・リレーション・ドット記法の値をまとめたオブジェクトです。

### 設定例

```ts
sources: {
  herbs: {
    // ...
    meta: ["name", "tags", "herbState.name", "reports.reportGroupSlug"],
  }
}
```

### 出力例（herbs.meta.json）

```json
{
  "matricaria-chamomilla": {
    "name": "カモミール",
    "tags": ["リラックス", "消化"],
    "herbState.name": "乾燥",
    "reports.reportGroupSlug": ["reportGroup001", "reportGroup002"]
  },
  ...
}
```

- hasMany リレーションや配列フィールドはフラットな配列になります。
- ドット記法でリレーション先の属性も抽出できます。
- throughリレーションや多段リレーションもサポートしています。

## Fast Querying with Index Files

QueryBuilder はデフォルトで `output/` ディレクトリの index ファイルを利用し、比較的高速に検索します。  
`options({ indexDir: "..." })` でインデックスディレクトリを指定できます。

### Speed Comparison Example

```ts
import { QueryBuilder } from "@migiwa-ya/staticql";
import db from "./staticql.config";
import { DataLoader } from "@migiwa-ya/staticql";
import { Indexer } from "@migiwa-ya/staticql";

async function main() {
  const config =
    (db as any).config || (db as any)._config || (db as any)["config"];
  const loader = new DataLoader(config);
  const indexer = new Indexer(loader, config);

  // Ensure indexes are built and saved
  await indexer.buildAll();
  await indexer.saveTo("output");

  // Query using index
  const qbIndexed = new QueryBuilder(
    "herbs",
    config,
    loader,
    [],
    indexer
  ).options({ indexMode: "only", indexDir: "output" });
  const t1 = Date.now();
  const herbsIndexed = await qbIndexed
    .where("name", "eq", "ペパーミント")
    .exec();
  const t2 = Date.now();

  // Query with full scan
  const qbScan = new QueryBuilder("herbs", config, loader, [], indexer).options(
    { indexMode: "none" }
  );
  const t3 = Date.now();
  const herbsScan = await qbScan.where("name", "eq", "ペパーミント").exec();
  const t4 = Date.now();

  console.log("With index:", herbsIndexed, `Time: ${t2 - t1}ms`);
  console.log("Full scan:", herbsScan, `Time: ${t4 - t3}ms`);
}

main();
```

## Meta Extraction & Dot Notation

- meta: ["reports.reportGroupSlug"] のようにドット記法でリレーション先の属性も抽出できます。
- hasMany リレーションの場合は値がフラットな配列になります。

## Through Relations (hasOneThrough / hasManyThrough)

- Through リレーションは、中間テーブル（モデル）を経由してリレーションを定義できます。
- 例: `herbs` から `reports` を `combinedHerbs` 経由で取得する場合など。

### 設定例

```ts
relations: {
  processThroughReportGroup: {
    to: "processes",
    through: "reportGroups",
    sourceLocalKey: "reportGroupSlug",
    throughForeignKey: "slug",
    throughLocalKey: "processSlug",
    targetForeignKey: "slug",
    type: "hasOneThrough",
  },
}
```

- `hasOneThrough` も同様に type を指定できます。
- QueryBuilder で `.join("processThroughReportGroup")` で利用可能です。
- meta: ["processThroughReportGroup.name"] のようにドット記法で中間リレーション先の属性も抽出できます。

## For Contributors: Utilities

- `buildForeignKeyMap`, `getAllFieldValues`, `extractNestedProperty` などのユーティリティ関数を `src/utils.ts` に集約しています。
- リレーションやネストした属性の抽出処理はこれらを使ってください。

## 実行例（Node.js）

```ts
import db from "./staticql.config.ts";

const result = await db
  .from("herbs")
  .join("herbState")
  .where("name", "contains", "ミント")
  .exec();

console.log(result);
```

## ライセンス

MIT

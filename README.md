# staticql

staticql は、Markdown / YAML / JSON ファイルを型安全に読み込み、検索・結合できるシンプルなデータクエリエンジンです。小規模な構造化コンテンツを扱う Jamstack / SSG を想定しています。

## 特長

- Zod によるスキーマバリデーション
- SQL ライクなクエリ（where / join）
- CLI でインデックファイル、API 用メタファイルを出力可能

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
  storage: {
    type: "filesystem",
    output: "output",
  },
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
          type: "hasOne",
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

### 型定義(TypeScript)の生成

TypeScript 型定義ファイルを自動生成するには、次のコマンドを実行します。

```bash
npx statical-gen-types staticql.config.ts types
```

- 第一引数: 設定ファイルのパス (例: staticql.config.ts)
- 第二引数: 型定義ファイルの出力ディレクトリ (例: types)

生成結果: `types/staticql-types.d.ts` に型定義が出力されます。

### インデックスファイルの生成

各 source のインデックスファイルや meta ファイルを生成するには、次のコマンドを実行します。

```bash
npx staticql-gen-index staticql.config.ts public/index/
```

- 第一引数: 設定ファイルのパス (例: staticql.config.ts)
- 第二引数: インデックスファイルの出力ディレクトリ (例: public/index/)

このコマンドにより、各 source ごとに `index-*.json` や `meta.json` などのファイルが指定ディレクトリに出力されます。  
出力例: `public/index/herbs.index-name.json`, `public/index/herbs.meta.json` など。

## Index/Meta File Structure

- 各 source ごとに、`index-{field}.json`（インデックスファイル）が出力されます。  
  例: `herbs.index-name.json` は name ごとの slug 配列を持ちます。
- `meta.json` ファイルは、meta: [] で指定した属性やリレーションの値を slug ごとにまとめて出力します。
- ドット記法（例: `"reports.reportGroupSlug"`）でリレーション先の属性も抽出できます。

### インデックスファイルの分割方式（splitIndexByKey）

データ量が多い場合、インデックスファイルを「キーごと」に分割して出力することができます。  
`staticql.config.ts` の各 source ブロックで `splitIndexByKey: true` を指定すると、  
インデックスファイルがキーごとにサブディレクトリ分割され、必要なキーのみを効率的に読み込めます。

#### 設定例

```ts
sources: {
  reportGroups: {
    // ...
    index: ["processSlug"],
    splitIndexByKey: true, // ← 追加
  }
}
```

#### 出力例

```
output/
└── reportGroups/
    └── index-processSlug/
        ├── 001.json
        ├── 002.json
        └── ...
```

- それぞれのファイル（例: `001.json`）には、そのキー値に該当する slug 配列が格納されます。
- デフォルト（splitIndexByKey 未指定または false）は従来通り `reportGroups.index-processSlug.json` 1 ファイルに全件が格納されます。

#### どちらを選ぶべきか

- データ量が少ない場合や全件一括ロードが許容される場合は従来方式で十分です。
- データ量が多くインデックスファイルが巨大化する場合は、分割方式（splitIndexByKey: true）を推奨します。

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
- through リレーションや多段リレーションもサポートしています。

## Fast Querying with Index Files

QueryBuilder は `defineContentDB` の `storage.output` ディレクトリの index ファイルを利用し、比較的高速に検索します。  

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
  );
  const t1 = Date.now();
  const herbsIndexed = await qbIndexed
    .where("name", "eq", "ペパーミント")
    .exec();
  const t2 = Date.now();

  // Query with full scan
  const qbScan = new QueryBuilder("herbs", config, loader, [], indexer);
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
- 例: `herbs` から `processes` を `reportGroups` 経由で取得する場合など。

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

## Cloudflare R2 ストレージ対応

staticql はローカルファイルだけでなく、Cloudflare R2 ストレージもデータソース・出力先として利用できます。  
CLI・QueryBuilder・Indexer・型生成など全ての I/O が StorageProvider で抽象化されており、設定ファイルで storage.type を切り替えるだけでローカル/クラウド両対応となります。
**なお、現状は Cloudflare Workers での利用を想定しており、バインドされた R2Bucket を渡す必要があるため定義ファイルでは defineContentDB による初期化は行わず、実際に利用するコード内で R2Bucket 参照を渡してから初期化します。**

### 設定例（R2 バケット利用）

```ts
// staticql.config.ts
import { z } from "zod";
import type { ContentDBConfig } from "@migiwa-ya/staticql";

export default {
  sources: {
    // ...従来通り
  },
} satisfies Omit<ContentDBConfig, "storage">;
```

```ts
import config from "../staticql.config";
import { defineContentDB } from "@migiwa-ya/staticql";

export default {
  async fetch(request, env: any, ctx): Promise<Response> {
    const db = await defineContentDB({
      ...config,
      storage: {
        type: "r2",
        bucket: env.MY_BUCKET,
      },
    });

    const herbs = await db.from("herbs").exec();

    return new Response(herbs[0].name);
  },
} satisfies ExportedHandler<Env>;
```

## ライセンス

MIT

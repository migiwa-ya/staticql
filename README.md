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
import { defineStaticQL } from "@migiwa-ya/staticql";
import { z } from "zod";

export default defineStaticQL({
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

各 source のインデックスファイルを生成するには、次のコマンドを実行します。

```bash
npx staticql-gen-index staticql.config.ts
```

- 第一引数: 設定ファイルのパス (例: staticql.config.ts)

このコマンドにより、各 source ごとに `index-*.json` などのファイルが `staticql.config.ts` の `storage.output` に出力されます。  
出力例: `public/index/herbs.index-name.json` など。

## Index File Structure

- 各 source ごとに、`index-{field}.json`（インデックスファイル）が出力されます。  
  例: `herbs.index-name.json` は name ごとの slug 配列を持ちます。

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
- デフォルト（splitIndexByKey 未指定または false）は `reportGroups.index-processSlug.json` 1 ファイルに全件が格納されます。

#### どちらを選ぶべきか

- データ量が少ない場合や全件一括ロードが許容される場合は従来方式で十分です。
- データ量が多くインデックスファイルが巨大化する場合は、分割方式（splitIndexByKey: true）を推奨します。

## Fast Querying with Index Files

QueryBuilder は `defineStaticQL` の `storage.output` ディレクトリの index ファイルを利用し、比較的高速に検索します。

### Speed Comparison Example

```ts
import define from "../tests/staticql.config.ts";
import { HerbsRecord } from "../tests/types/staticql-types";

async function main() {
  const staticql = define();
  await staticql.saveIndexes();

  const result = await staticql
    .from<HerbsRecord>("herbs")
    .where("name", "eq", "mentha-piperita")
    .join("reports")
    .exec();

  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

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

## Cloudflare R2 ストレージ対応（Cloudflare Workers）

staticql はローカルファイルだけでなく、Cloudflare R2 ストレージもデータソース・出力先として利用できます（Cloudflare Workers での利用のみ）。  
CLI・QueryBuilder・Indexer・型生成など全ての I/O が StorageProvider で抽象化されており、設定ファイルで storage.type を切り替えるだけでローカル/クラウド両対応となります。

### 設定例（Cloudflare Workers での R2 バケット利用）

```ts
# staticql.config.ts

import { defineStaticQL } from '@migiwa-ya/staticql/workerd';
import { z } from 'zod';

export default defineStaticQL({
	storage: {
		type: 'r2',
		output: '',
	},
	sources: {
  ...
  }
});

```

```ts
import define from "../staticql.config";
import { HerbsRecord } from "../types/staticql-types";

export default {
  async fetch(request, env: any, ctx): Promise<Response> {
    const staticql = define(env.MY_BUCKET);

    const herbs = await db.from<HerbsRecord>("herbs").exec();

    return new Response(herbs[0].name);
  },
} satisfies ExportedHandler<Env>;
```

## ライセンス

MIT

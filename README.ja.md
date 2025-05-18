# StaticQL

StaticQL（Static File Query Layer） は、Markdown / YAML / JSON の静的ファイルをそのまま結合・検索できる軽量な静的データレイヤーです。型定義ベースで型推論が効くクエリを、TypeScript の標準構文で記述できます。小〜中規模の Jamstack や API での利用を想定していますが、幅広い場面での活用を目指しています。

## 特長

- JSON Schema によるソース定義と簡易バリデーション
- 型推論つき cursor ベースクエリ（where: eq, in, startsWith / join / orderBy / 双方向ページネーション）
- インデックスファイルの生成と活用による高速検索
- Node.js / ブラウザ / Cloudflare Workers に対応
- 定義ファイルとコンテンツ、インデックスの公開で Web UI でも利用可能

## インストール

```
npm install staticql
```

## Quick Start

```ts
import { defineStaticQL } from "staticql";

// ローカルファイルシステムから読み込むためのリポジトリ（Node.js用）
import { FsRepository } from "staticql/repo/fs";

// データソース定義から生成された型定義（生成方法は後述）
import { HerbsRecord } from "./staticql-types";

// データソースの定義
const factory = defineStaticQL({
  sources: {
    herbs: {
      // 対象ファイルパターン
      pattern: "content/herbs/*.md",
      // ファイル形式
      type: "markdown",
      schema: {
        // JSON Schema による構造定義
        type: "object",
        properties: {
          name: { type: "string" },
          overview: { type: "string" },
        },
        required: ["name", "overview"],
      },
      // インデックスを生成するキー
      index: ["name"],
    },
  },
});

// StaticQL インスタンスの生成・リポジトリを注入
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

**各レコードの slug はファイル名から自動で抽出されます。スキーマに明記する必要はありません**

## スキーマ型定義の生成

TypeScript の補完や型推論を有効にするため、`staticql-types.ts` を自動生成できます。
生成された型を `from<HerbsRecord>()` のように使うと、クエリの補完が有効になります。

```bash
# npx staticql-gen-types <config_file> <output_dir>
npx staticql-gen-types ./staticql.config.json ./
```

## インデックスファイルの生成

検索クエリの高速化のために、事前にインデックスファイルを作成します。
生成されたインデックスは `.where()` や `.join()` 時に利用され、ファイル全体のフルスキャンを回避できます。

### 全インデックス生成

```bash
# npx staticql-gen-index <config_file> <output_dir>
npx staticql-gen-index ./staticql.config.json ./public/index/
```

### 差分インデックス作成

```bash
# npx staticql-gen-index <config_file> <output_dir> --incremental --diff-file=<diff_file>
npx staticql-gen-index ./staticql.config.json ./public/index/ --incremental --diff-file=./diff.json
```

#### 差分情報フォーマット

差分情報は JSON 形式で受け渡します。  
1 行ごとに 1 ファイルの差分を表現し、以下のような配列とします。

```json
[
  { "status": "A", "source": "herbs", "slug": "xxx" }
  { "status": "D", "source": "recipes", "slug": "yyy" }
]
```

- `status`: "A"=追加, "D"=削除
- `source`: 更新対象ソース名
- `slug`: 更新対象の slug

## リレーションの定義と利用（Join）

StaticQL では、`join()` を使って異なるデータソースを結合できます。

各レコードの slug はファイル名から自動で抽出されます。スキーマに明記する必要はありません

### データ例

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

### 定義ファイル（抜粋）

```jsonc
// ./staticql.config.json

{
  "sources": {
    "herbs": {
      "pattern": "content/herbs/*.md",
      "type": "markdown",
      "schema": {
        /* 省略 */
      },
      "relations": {
        "tags": {
          // タグとの hasMany リレーション（多対多）
          "to": "tags",
          "localKey": "tagSlugs",
          "foreignKey": "slug",
          "type": "hasMany"
        },
        "recipes": {
          // 中間テーブルを介した hasManyThrough リレーション
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
        /* 省略 */
      }
    },

    "recipeGroups": {
      "path": "content/recipeGroups/*.json",
      "type": "json",
      "schema": {
        /* 省略 */
      }
    },

    "recipes": {
      "pattern": "content/recipes/*.md",
      "type": "markdown",
      "schema": {
        /* 省略 */
      }
    }
  }
}
```

※relations に定義されたリレーション先のキーは、自動的にインデックスされるため、index フィールドに個別指定する必要はありません。

### クエリ例

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
  .exec();

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

## ライセンス

MIT

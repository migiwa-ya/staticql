# staticql

StaticQL（Static File Query Layer） は、Markdown / YAML / JSON の静的ファイルをそのまま結合・検索できる軽量な静的データレイヤーです。型定義ベースで型推論が効くクエリを、TypeScript の標準構文で記述できます。小〜中規模の Jamstack や API での利用を想定していますが、幅広い場面での活用を目指しています。

## 特長

- JSON Schema によるソース定義と簡易バリデーション
- 型推論が効く SQL ライクなクエリ（where / join）
- インデックスファイルの生成と活用による高速検索
- Node.js / ブラウザ / Cloudflare Workers に対応
- プラガブルなストレージ設計（fs, fetch, Workers の R2 など）
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
      // インデックスファイルをキーごとに分割
      splitIndexByKey: true,
    },
  },
});

// StaticQL インスタンスの生成・リポジトリを注入
const staticql = factory({ repository: new FsRepository("tests/") });

const result = await staticql
  .from<HerbsRecord>("herbs")
  .where("name", "eq", "ラベンダー")
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

差分情報は、git diff などから整形しやすい JSON 形式で受け渡します。  
1 行ごとに 1 ファイルの差分を表現し、以下のような配列とします。

```json
[
  { "status": "A", "path": "content/foo.md" },
  { "status": "M", "path": "content/bar.md" },
  { "status": "D", "path": "content/baz.md" },
  { "status": "R", "path": "content/new.md", "oldPath": "content/old.md" }
]
```

- status: "A"=追加, "M"=変更, "D"=削除, "R"=リネーム
- path: 追加/変更後のパス
- oldPath: リネーム時の元パス

### 差分情報の生成例

```sh
git diff --name-status $BASE_SHA $HEAD_SHA | awk '{ if ($1 == "R100") print "{\"status\":\"R\",\"path\":\""$3"\",\"oldPath\":\""$2"\"}"; else if ($1 == "A" || $1 == "M" || $1 == "D") print "{\"status\":\""$1"\",\"path\":\""$2"\"}"; }' | jq -s . > diff.json
```

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
import { defineStaticQL } from "staticql";
import { FsRepository } from "staticql/repo/fs";
import { HerbsRecord } from "./staticql-types";

const factory = defineStaticQL({
  sources: {
    // ...（前述の定義ファイルに準拠）
  },
});

const staticql = factory({
  repository: new FsRepository("tests/"),
});

const result = await staticql
  .from<HerbsRecord>("herbs")
  .join("tags")
  .join("recipes")
  .where("name", "eq", "ペパーミント")
  .exec();

console.log(result);
/*
[
  {
    slug: 'peppermint',
    name: 'ペパーミント',
    tags: [
      { slug: 'relax', name: 'リラックス' },
      { slug: 'digest', name: '消化' }
    ],
    recipes: [
      { slug: 'mint-tea', title: 'ミントティー', recipeGroupSlug: 'grp01' }
    ]
  }
]
*/
```

## Contact

For questions, feedback, or collaboration, feel free to reach out via:

- Blog: https://migiwa-ya.dev/about
- X: https://x.com/migiwa_ya_com
- GitHub Issues or Discussions

## ライセンス

MIT

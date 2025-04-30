import { defineStaticQL } from "../dist/src/index.browser.js";

// staticql.schema.json を fetch して初期化
async function main() {
  // スキーマ取得
  const schema = await fetch("/staticql.schema.json").then((r) => r.json());

  // StaticQL インスタンス生成
  const staticql = defineStaticQL(schema)();

  // 例: herbs ソースをクエリ
  const herbs = await staticql.from("herbs").exec();

  // 結果出力
  console.log("herbs:", herbs);

  // 例: where 句でフィルタ
  const chamomile = await staticql
    .from("herbs")
    .join("reports")
    .where("slug", "eq", "matricaria-chamomilla")
    .exec();
  console.log("chamomile:", chamomile);
}

main().catch(console.error);

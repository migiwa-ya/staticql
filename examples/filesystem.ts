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

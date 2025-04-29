import db from "../tests/staticql.config.ts";

async function main() {
  const result = await db
    .from("herbs")
    .where("name", "eq", "mentha-piperita")
    .join("reports")
    .exec();

  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { describe, it, expect, beforeAll } from "vitest";
import { defineStaticQL } from "../src/index.node";
import staticqlConfig from "./staticql.config.json";
import { StaticQLConfig } from "../src/StaticQL";

describe("Node.js Interface Test", () => {
  it("---", async () => {
    const config = staticqlConfig as StaticQLConfig;

    const staticql = defineStaticQL(config)({ baseDir: "tests/public/" });

    // await staticql.getIndexer().save();
    // console.log(staticql.getIndexer().save())
    // console.log(staticql.saveIndexes())

    const result = await staticql
      .from("reports")
      .join("herbs")
      .where("combinedHerbs.slug", "eq", "matricaria-chamomilla")
      .exec();
    console.log(result);
  });
});

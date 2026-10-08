import type { StaticQL } from "../../../src/StaticQL.js";

export interface QueryInputs {
  name: string;
  nameUpper: string;
  herbSlug: string;
}

export async function executeScenarios(staticql: StaticQL, inputs: QueryInputs) {
  const index = await staticql.from("herbs")
    .where("name", "eq", inputs.name)
    .exec();
  const custom = await staticql.from("herbs")
    .where("nameUpper", "eq", inputs.nameUpper)
    .exec();
  const relation = await staticql.from("recipes")
    .join("herbs")
    .where("herbs.slug", "in", [inputs.herbSlug])
    .exec();
  const through = await staticql.from("recipes").join("process").exec();
  const list = await staticql.from("herbs").exec();
  return {
    "S-index": index,
    "S-custom": custom,
    "S-relation": relation,
    "S-through": through,
    "S-list": list,
  };
}

export async function executeC4Query(staticql: StaticQL, kind: "Q-index" | "Q-relation", inputs: QueryInputs) {
  if (kind === "Q-index") {
    return staticql.from("herbs").where("name", "eq", inputs.name).exec();
  }
  return staticql.from("recipes").join("herbs")
    .where("herbs.slug", "in", [inputs.herbSlug]).exec();
}

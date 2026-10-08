import { describe, expect, it } from "vitest";
import { IndexConfigFactory, IndexConfigInput } from "../src/IndexConfigFactory.js";

describe("through relation index fields (#71)", () => {
  it("indexes source, middle, and target keys in their respective sources", () => {
    const chain = {
      type: "hasManyThrough" as const,
      through: "t",
      to: "w",
      sourceLocalKey: "ownerId",
      throughForeignKey: "ownerId",
      throughLocalKey: "targetCode",
      targetForeignKey: "code",
    };
    const sources: Record<string, IndexConfigInput> = {
      s: { relations: { chain } },
      t: {},
      w: {},
    };
    const factory = new IndexConfigFactory();

    expect(Object.keys(factory.buildForSource("s", sources.s, sources))).toContain("ownerId");
    expect(Object.keys(factory.buildForSource("t", sources.t!, sources))).toContain("ownerId");
    expect(Object.keys(factory.buildForSource("w", sources.w!, sources))).toContain("code");
    expect(Object.keys(factory.buildForSource("s", sources.s, sources))).not.toContain("code");
    expect(Object.keys(factory.buildForSource("t", sources.t!, sources))).not.toContain("targetCode");
    expect(Object.keys(factory.buildForSource("w", sources.w!, sources))).not.toContain("ownerId");
  });

  it("keeps all roles when a source is both the through and target source", () => {
    const relation = {
      type: "hasManyThrough" as const,
      through: "shared",
      to: "shared",
      sourceLocalKey: "ownerId",
      throughForeignKey: "ownerId",
      throughLocalKey: "targetCode",
      targetForeignKey: "code",
    };
    const sources: Record<string, IndexConfigInput> = {
      source: { relations: { relation } },
      shared: {},
    };
    const indexes = Object.keys(
      new IndexConfigFactory().buildForSource("shared", sources.shared!, sources)
    );

    expect(indexes).toContain("ownerId");
    expect(indexes).toContain("code");
  });
});

import { describe, expect, it } from "vitest";
import { IndexConfigFactory, IndexConfigInput } from "../src/IndexConfigFactory.js";

describe("relation index path validation (#84)", () => {
  function sources(): Record<string, IndexConfigInput> {
    return {
      s: {
        relations: {
          r: { type: "hasMany", to: "t", localKey: "rel", foreignKey: "slug" },
        },
      },
      t: {
        relations: {
          x: { type: "hasMany", to: "u", localKey: "next", foreignKey: "slug" },
        },
      },
      u: {},
    };
  }

  it.each(["r.x.name", "r.x"])("rejects the direct relation path %s with a diagnostic", (fieldName) => {
    const config = sources();
    config.s.index = { [fieldName]: {} };

    expect(() => new IndexConfigFactory().buildForSource("s", config.s, config)).toThrow(
      `[s] index path "${fieldName}" traverses relation "x" on related source "t"; only one-hop relation paths ("<relation>.<field>") are supported`
    );
  });

  it("rejects a through path using the target source's relations", () => {
    const config = sources();
    config.s.relations = {
      r: {
        type: "hasManyThrough", through: "middle", to: "t",
        sourceLocalKey: "slug", throughForeignKey: "owner",
        throughLocalKey: "target", targetForeignKey: "slug",
      },
    };
    config.middle = {};
    config.s.index = { "r.x.name": {} };

    expect(() => new IndexConfigFactory().buildForSource("s", config.s, config)).toThrow(
      '[s] index path "r.x.name" traverses relation "x" on related source "t"; only one-hop relation paths ("<relation>.<field>") are supported'
    );
  });

  it("preserves indexes for one-hop and nested target data fields", () => {
    const config = sources();
    config.s.index = { "r.name": {}, "r.meta.title": {} };

    const indexes = new IndexConfigFactory().buildForSource("s", config.s, config);
    expect(Object.keys(indexes)).toContain("r.name");
    expect(Object.keys(indexes)).toContain("r.meta.title");
  });

  it("preserves ordinary field indexes without relations", () => {
    const config: Record<string, IndexConfigInput> = {
      s: { index: { name: {}, "a.b": {} } },
    };

    const indexes = new IndexConfigFactory().buildForSource("s", config.s, config);
    expect(Object.keys(indexes).sort()).toEqual(["a.b", "name", "slug"]);
  });

  it("preserves custom indexes even when their names contain two relations", () => {
    const config = sources();
    config.s.customIndex = { "r.x.name": {} };

    const indexes = new IndexConfigFactory().buildForSource("s", config.s, config);
    expect(Object.keys(indexes)).toContain("r.x.name");
  });

  it("preserves an index when the related source is undefined", () => {
    const config = sources();
    delete config.t;
    config.s.index = { "r.x.name": {} };

    const indexes = new IndexConfigFactory().buildForSource("s", config.s, config);
    expect(Object.keys(indexes)).toContain("r.x.name");
  });
});

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

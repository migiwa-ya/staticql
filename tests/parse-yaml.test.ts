import { describe, it, expect } from "vitest";
import { parseYAML } from "../src/utils/parser";

describe("parseYAML配列オブジェクトパース", () => {
  it("combinedHerbs: - slug: rumex-crispus ... を正しく配列オブジェクトとしてパースできる", () => {
    const content = `
- slug: reportGroup001
  processSlug: infusion
  combinedHerbs:
    - slug: rumex-crispus
      herbStateSlug: dry
      herbPartSlug: root

- slug: reportGroup002
  processSlug: tincture
  combinedHerbs:
    - slug: rumex-crispus
      herbStateSlug: dry
      herbPartSlug: root
`;
    const data = parseYAML(content);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);

    expect(data[0].slug).toBe("reportGroup001");
    expect(data[0].processSlug).toBe("infusion");
    expect(Array.isArray(data[0].combinedHerbs)).toBe(true);
    expect(data[0].combinedHerbs.length).toBe(1);
    expect(data[0].combinedHerbs[0]).toEqual({
      slug: "rumex-crispus",
      herbStateSlug: "dry",
      herbPartSlug: "root",
    });

    expect(data[1].slug).toBe("reportGroup002");
    expect(data[1].processSlug).toBe("tincture");
    expect(Array.isArray(data[1].combinedHerbs)).toBe(true);
    expect(data[1].combinedHerbs.length).toBe(1);
    expect(data[1].combinedHerbs[0]).toEqual({
      slug: "rumex-crispus",
      herbStateSlug: "dry",
      herbPartSlug: "root",
    });
  });
});

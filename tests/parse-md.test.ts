import { describe, it, expect } from "vitest";
import { parseMarkdown } from "../src/utils/parser";

describe("parseMarkdown YAML配列オブジェクトパース", () => {
  it("combinedHerbs: - slug: rumex-crispus ... を正しく配列オブジェクトとしてパースできる", () => {
    const content = `---
- slug: reportGroup001
  processSlug: infusion
  combinedHerbs:
    - slug: rumex-crispus
      herbStateSlug: dry
      herbPartSlug: root
    - slug: urtica-dioica
      herbStateSlug: fresh
      herbPartSlug: leaf
---
本文
`;
    const { attributes, body } = parseMarkdown(content);
    expect(attributes.slug).toBe("reportGroup001");
    expect(attributes.processSlug).toBe("infusion");
    expect(Array.isArray(attributes.combinedHerbs)).toBe(true);
    expect(attributes.combinedHerbs.length).toBe(2);
    expect(attributes.combinedHerbs[0]).toEqual({
      slug: "rumex-crispus",
      herbStateSlug: "dry",
      herbPartSlug: "root",
    });
    expect(attributes.combinedHerbs[1]).toEqual({
      slug: "urtica-dioica",
      herbStateSlug: "fresh",
      herbPartSlug: "leaf",
    });
    expect(body.trim()).toBe("本文");
  });
});


describe("parseMarkdown YAML配列オブジェクトパース", () => {
  it("配列表記をパースできる", () => {
    const content = `---
name: ペパーミント
nameScientific: Mentha piperita
nameAliases: [ペパーミント]
tags: [refresh, digestion, relax]
herbStateSlug: fresh
---

## History

Peppermint is a hybrid mint
`;
    const { attributes, body } = parseMarkdown(content);
    expect(attributes.tags.length).toBe(3);
    expect(attributes.tags[0]).toBe('refresh');
  });
});
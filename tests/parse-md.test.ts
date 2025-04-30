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
    expect(Array.isArray(attributes.nameAliases)).toBe(true);
    expect(attributes.nameAliases.length).toBe(1);
    expect(attributes.nameAliases[0]).toBe('ペパーミント');
  });
});

describe("parseMarkdown YAML配列（改行表記）オブジェクトパース", () => {
  it("改行表記の配列表記をパースできる", () => {
    const content = `---
slug: melissa-officinalis
name: レモンバーム
nameScientific: Melissa officinalis
nameEn: Lemon balm
nameAliases:
  [
    香水薄荷（コウスイハッカ）,
    メリッサ,
    セイヨウヤマハッカ（西洋山薄荷）,
    メリッサソウ,
  ]
---
Desc
`;
    const { attributes, body } = parseMarkdown(content);
    expect(Array.isArray(attributes.nameAliases)).toBe(true);
    expect(attributes.nameAliases.length).toBe(4);
    expect(attributes.nameAliases[0]).toBe('香水薄荷（コウスイハッカ）');
    expect(attributes.nameAliases[1]).toBe('メリッサ');
    expect(attributes.nameAliases[2]).toBe('セイヨウヤマハッカ（西洋山薄荷）');
    expect(attributes.nameAliases[3]).toBe('メリッサソウ');
  });
});

describe("parseMarkdown 日時表現パース", () => {
  it("日時表現をパースしてDate型にできる", () => {
    const content = `---
name: ペパーミント
nameScientific: Mentha piperita
nameAliases: [ペパーミント]
tags: [refresh, digestion, relax]
herbStateSlug: fresh
createdAt: 2025-04-11T16:33:38+09:00
updatedAt: 2025-04-23T14:29:00+09:00
---
Desc
`;
    const { attributes, body } = parseMarkdown(content);
    expect(attributes.createdAt instanceof Date).toBe(true);
    expect(attributes.updatedAt instanceof Date).toBe(true);
    expect(attributes.createdAt.toISOString()).toBe("2025-04-11T07:33:38.000Z");
    expect(attributes.updatedAt.toISOString()).toBe("2025-04-23T05:29:00.000Z");
  });
});

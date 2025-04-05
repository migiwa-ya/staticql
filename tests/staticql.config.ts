import { defineContentDB } from "../src";
import { z } from "zod";

export default defineContentDB({
  sources: {
    herbs: {
      path: "tests/content-fixtures/herbs/*.md",
      type: "markdown",
      schema: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
          herbStateSlug: z.string(),
        })
      ),
      relations: {
        herbState: {
          to: "herbStates",
          localKey: "herbStateSlug",
          foreignKey: "slug",
        },
      },
      index: ["name", "herbState.name", "tags"],
    },

    herbStates: {
      path: "tests/content-fixtures/herbStates.yaml",
      type: "yaml",
      schema: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
        })
      ),
    },

    reports: {
      path: "tests/content-fixtures/reports/*.yaml",
      type: "yaml",
      schema: z.array(
        z.object({
          slug: z.string(),
          title: z.string(),
          herbSlug: z.string(),
        })
      ),
      relations: {
        herb: {
          to: "herbs",
          localKey: "herbSlug",
          foreignKey: "slug",
        },
      },
      index: ["title", "herb.name"],
    },
  },
});

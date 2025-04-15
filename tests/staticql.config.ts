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
          tags: z.array(z.string()),
        })
      ),
      relations: {
        herbState: {
          to: "herbStates",
          localKey: "herbStateSlug",
          foreignKey: "slug",
        },
        reports: {
          to: "reports",
          localKey: "slug",
          foreignKey: "combinedHerbs.slug",
        },
      },
      index: ["name", "herbState.name", "tags", "reports.reportGroupSlug"],
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
      path: "tests/content-fixtures/reports/**/*.md",
      type: "markdown",
      schema: z.array(
        z.object({
          slug: z.string(),
          reportGroupSlug: z.string(),
          summary: z.string(),
          processSlug: z.string(),
          combinedHerbs: z.array(
            z.object({
              slug: z.string(),
              herbStateSlug: z.string(),
              herbPartSlug: z.string(),
              description: z.string(),
            })
          ),
        })
      ),
      relations: {
        herbs: {
          to: "herbs",
          localKey: "combinedHerbs.slug",
          foreignKey: "slug",
        },
        processThroughReportGroup: {
          to: "processes",
          through: "reportGroups",
          sourceLocalKey: "reportGroupSlug",
          throughForeignKey: "slug",
          throughLocalKey: "process",
          targetForeignKey: "slug",
          type: "hasOneThrough",
        },
      },
      index: [
        "reportGroupSlug",
        "processSlug",
        "combinedHerbs.slug",
        "herbs.name",
        "processThroughReportGroup.name",
      ],
    },

    reportGroups: {
      path: "tests/content-fixtures/reportGroups.yaml",
      type: "yaml",
      schema: z.array(
        z.object({
          slug: z.string(),
          herbSlugs: z.array(z.string()),
          process: z.string(),
        })
      ),
      index: ["herbSlugs", "process"],
    },

    processes: {
      path: "tests/content-fixtures/processes.yaml",
      type: "yaml",
      schema: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
          description: z.string(),
        })
      ),
    },
  },
});

import { defineContentDB } from "../src/index.js";
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
          type: "hasOne",
        },
        reports: {
          to: "reports",
          localKey: "slug",
          foreignKey: "combinedHerbs.slug",
          type: "hasMany",
        },
      },
      index: ["name", "herbState.name", "reports.reportGroupSlug", "tags"],
      splitIndexByKey: true,
      meta: ["name", "tags", "herbState.name", "reports.reportGroupSlug"],
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
          type: "hasMany",
        },
        reportGroup: {
          to: "reportGroups",
          localKey: "reportGroupSlug",
          foreignKey: "slug",
          type: "hasOne",
        },
        processThroughReportGroup: {
          to: "processes",
          through: "reportGroups",
          sourceLocalKey: "reportGroupSlug",
          throughForeignKey: "slug",
          throughLocalKey: "processSlug",
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
      meta: ["herbs.name", "processThroughReportGroup.name"],
    },

    reportGroups: {
      path: "tests/content-fixtures/reportGroups.yaml",
      type: "yaml",
      schema: z.array(
        z.object({
          slug: z.string(),
          processSlug: z.string(),
        })
      ),
      index: ["processSlug"],
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
      index: ["name"],
    },
  },
});

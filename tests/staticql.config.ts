import { defineStaticQL } from "@migiwa-ya/staticql";
import { z } from "zod";

export default defineStaticQL({
  storage: {
    type: "filesystem",
    output: "tests/public/",
  },
  sources: {
    herbs: {
      path: "tests/public/content/herbs/*.md",
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
          type: "belongsToMany",
        },
      },
      index: ["name", "herbState.name", "reports.reportGroupSlug", "tags"],
      splitIndexByKey: true,
    },

    herbStates: {
      path: "tests/public/content/herbStates.yaml",
      type: "yaml",
      schema: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
        })
      ),
    },

    reports: {
      path: "tests/public/content/reports/**/*.md",
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
    },

    reportGroups: {
      path: "tests/public/content/reportGroups.yaml",
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
      path: "tests/public/content/processes.yaml",
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

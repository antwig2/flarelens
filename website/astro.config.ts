import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, {
  defineConfig as defineNimbusConfig,
} from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const nimbusConfig = defineNimbusConfig({
  site: "https://flarelens.dev",
  title: "FlareLens",
  description:
    "Open-source self-hosted Platform-as-a-Service running in your own Cloudflare account and on your own servers.",
  locale: "en",
  homeLabel: "Docs",
  github: "https://github.com/antwig2/flarelens",
  editPattern: "https://github.com/antwig2/flarelens/edit/main/website/{path}",
  socialImageAlt: "FlareLens — Your infrastructure. Under your control.",
  sidebar: {
    items: [
      "docs",
      {
        label: "Foundation",
        items: ["docs/getting-started", "docs/architecture"],
      },
      {
        label: "Platform Capabilities",
        items: [
          "docs/fleet",
          "docs/deployments",
          "docs/mesh",
          "docs/observability",
          "docs/secrets-and-flags",
          "docs/backups",
        ],
      },
      {
        label: "Reference & Ecosystem",
        items: [
          "docs/reference",
          {
            label: "Fleet JSON Schema",
            link: "https://flarelens.dev/schemas/fleet.schema.json",
          },
        ],
      },
    ],
  },
});

export default defineConfig({
  // nimbus:adapter
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    nimbus(nimbusConfig, {
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      markdown: {
        hastPlugins: [tableScroll()],
        features: { headingAttributes: true },
      },
    }),
  ],
});

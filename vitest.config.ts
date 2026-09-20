import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// fileURLToPath, not URL.pathname: pathname keeps the percent-encoding, so a
// checkout under a directory with a space in it resolved "@" to a path that
// does not exist and every aliased import failed.
const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/meet/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fromRoot("./src"),
      "server-only": fromRoot("./test/server-only.ts"),
    },
  },
});

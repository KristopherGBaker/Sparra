import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /** Run only project test files; never walks into node_modules. */
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**"],
    environment: "node",
  },
});

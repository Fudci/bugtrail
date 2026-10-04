import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.int.test.ts"],
    exclude: ["**/node_modules/**"],
    globalSetup: ["./test/int-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});

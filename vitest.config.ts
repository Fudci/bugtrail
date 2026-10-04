import { configDefaults, defineConfig } from "vitest/config";

// Unit test saja; integration test (*.int.test.ts) lewat vitest.int.config.ts.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/*.int.test.ts"] },
});

import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

export default mergeConfig(baseConfig, {
  test: {
    exclude: ["**/*.integration.test.ts", "**/*.smoke.test.ts"],
  },
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { configuration } from "../../src/config/index.js";
const valid = {
  MONGODB_URI: "mongodb://localhost/test",
  SESSION_SECRET: "x".repeat(32),
  PUBLIC_ORIGIN: "https://localhost:3443",
};
test("secure defaults and validation", () => {
  assert.equal(configuration(valid).HOST, "127.0.0.1");
  assert.throws(() =>
    configuration({ ...valid, PUBLIC_ORIGIN: "http://public.example" }),
  );
  assert.throws(() => configuration({ ...valid, HOST: "0.0.0.0" }));
  assert.throws(() => configuration({ ...valid, SESSION_SECRET: "short" }));
  assert.throws(() =>
    configuration({ ...valid, DATA_DIR: "./client/runtime" }),
  );
  assert.throws(() => configuration({ ...valid, DATA_DIR: "/" }));
});

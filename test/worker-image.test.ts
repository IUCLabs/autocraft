import { test } from "node:test";
import assert from "node:assert/strict";
import { componentsFor, containerfile } from "../src/worker/environment.ts";

test("a Rust build image gets rustfmt and clippy, which the stock image's minimal profile leaves out", () => {
  const f = containerfile("rust:1-bookworm", [], componentsFor("rust-stable"));
  assert.match(f, /^RUN rustup component add clippy rustfmt$/m);
  assert.doesNotMatch(f, /apt-get/);
});

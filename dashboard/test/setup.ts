import { afterEach } from "vitest";
import { cleanup } from "@testing-library/preact";

// Without this, testing-library doesn't unmount what a previous test in the
// same file rendered — the next render() just adds another tree to
// document.body, and any getByText/getByRole query that matches text in
// both trees fails with "multiple elements found" for reasons that have
// nothing to do with the component under test.
afterEach(() => {
  cleanup();
});

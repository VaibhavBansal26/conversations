import { describe, expect, it } from "vitest";
import { runDocsChecks, slug } from "../scripts/docs-check.js";

describe("documentation", () => {
  it("has no drift: links, index, generated references, mermaid, route/event/permission coverage, changelog", async () => {
    const problems = await runDocsChecks();
    expect(problems, problems.join("\n")).toEqual([]);
  }, 180_000);

  it("anchor slugs follow GitHub's rules", () => {
    expect(slug("Client to server")).toBe("client-to-server");
    expect(slug("7. Known limitations (honest list)")).toBe("7-known-limitations-honest-list");
    expect(slug("What is tested, and what is not")).toBe("what-is-tested-and-what-is-not");
  });
});

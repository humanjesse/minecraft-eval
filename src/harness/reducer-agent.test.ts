import { describe, expect, it } from "vitest";
import { ReducerError, parseReducerOutput } from "./reducer-agent.js";

describe("parseReducerOutput", () => {
  it("extracts structured reducer JSON from plain output", () => {
    expect(parseReducerOutput('{"digest":"Alice joined.","urgent":[],"quiet":false}')).toEqual({
      digest: "Alice joined.",
      urgent: [],
      quiet: false,
    });
  });

  it("extracts structured reducer JSON from fenced output", () => {
    expect(parseReducerOutput('```json\n{"digest":"","urgent":[{"kind":"crash","detail":"server stopped"}],"quiet":true}\n```')).toEqual({
      digest: "",
      urgent: [{ kind: "crash", detail: "server stopped" }],
      quiet: true,
    });
  });

  it("throws a reducer error when no JSON object is present", () => {
    expect(() => parseReducerOutput("nothing notable")).toThrow(ReducerError);
  });

  it("throws a reducer error when JSON is malformed", () => {
    expect(() => parseReducerOutput('{"digest":')).toThrow(ReducerError);
  });
});

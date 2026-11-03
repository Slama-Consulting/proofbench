import { describe, expect, it } from "vitest";
import { adfToText, truncate } from "../src/text.js";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("adfToText", () => {
  it("converts paragraphs, marks, mentions, lists, code and tables", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
        { type: "paragraph", content: [{ type: "text", text: "Hello ", marks: [{ type: "strong" }] }, { type: "mention", attrs: { text: "@Ada" } }, { type: "hardBreak" }, { type: "text", text: "second line" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [p("one")] }, { type: "listItem", content: [p("two")] }] },
        { type: "orderedList", content: [{ type: "listItem", content: [p("first")] }] },
        { type: "codeBlock", content: [{ type: "text", text: "npm test" }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [p("A")] }, { type: "tableCell", content: [p("B")] }] }] },
        { type: "paragraph", content: [{ type: "inlineCard", attrs: { url: "https://jira.example.com/browse/PROJ-2" } }] },
      ],
    };
    expect(adfToText(adf)).toBe("Steps\n\nHello @Ada\nsecond line\n\n- one\n- two\n\n1. first\n\n```\nnpm test\n```\n\nA | B\n\nhttps://jira.example.com/browse/PROJ-2");
  });

  it("passes plain strings through and tolerates junk", () => {
    expect(adfToText("plain wiki text")).toBe("plain wiki text");
    expect(adfToText(null)).toBe("");
    expect(adfToText({ type: "doc", content: "nope" })).toBe("");
    expect(adfToText(42)).toBe("");
  });

  it("stops on absurd nesting instead of overflowing", () => {
    let node: Record<string, unknown> = { type: "text", text: "deep" };
    for (let i = 0; i < 5000; i++) node = { type: "blockquote", content: [node] };
    expect(() => adfToText(node)).not.toThrow();
  });
});

describe("truncate", () => {
  it("flags a cut and leaves short text alone", () => {
    expect(truncate("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(truncate("abc", 3)).toEqual({ text: "abc", truncated: false });
  });
  it("never splits a surrogate pair", () => {
    const r = truncate("a\u{1F600}b", 2);
    expect(r.text).toBe("a");
    expect(r.truncated).toBe(true);
  });
});

import { expect, it } from "vitest";
import { isManagedRemoteImage, parseNoteUrl } from "../src/url.js";

it("accepts edit, share, and presentation URLs only on SJTU Notes", () => {
  expect(parseNoteUrl("https://notes.sjtu.edu.cn/abc").id).toBe("abc");
  expect(parseNoteUrl("https://notes.sjtu.edu.cn/s/abc").id).toBe("abc");
  expect(parseNoteUrl("https://notes.sjtu.edu.cn/p/abc").id).toBe("abc");
  expect(() => parseNoteUrl("https://example.com/abc")).toThrowError(/Only/);
  expect(() => parseNoteUrl("https://notes.sjtu.edu.cn/api/notes")).toThrowError(/identify/);
});

it("distinguishes managed uploads from ordinary external images", () => {
  expect(isManagedRemoteImage("https://notes.sjtu.edu.cn/uploads/a.png", new Set())).toBe(true);
  expect(isManagedRemoteImage("https://cdn.example/a.png", new Set(["https://cdn.example/a.png"]))).toBe(true);
  expect(isManagedRemoteImage("https://cdn.example/a.png", new Set())).toBe(false);
});

import { describe, it, expect } from "vitest";
import { parseTerminalMessage, PING_MESSAGE } from "./protocol";

describe("parseTerminalMessage", () => {
  it("recognises a heartbeat instead of typing it into the shell", () => {
    expect(parseTerminalMessage(PING_MESSAGE)).toEqual({ kind: "ping" });
  });

  it("recognises a resize and clamps it to at least 1x1", () => {
    expect(parseTerminalMessage(JSON.stringify({ type: "resize", cols: 120, rows: 0 }))).toEqual({
      kind: "resize",
      cols: 120,
      rows: 1,
    });
  });

  it("passes keystrokes through untouched", () => {
    expect(parseTerminalMessage("ls -la\r")).toEqual({ kind: "input", data: "ls -la\r" });
    expect(parseTerminalMessage("{")).toEqual({ kind: "input", data: "{" });
  });

  it("passes JSON that is not a control message through as input", () => {
    const text = JSON.stringify({ type: "other" });
    expect(parseTerminalMessage(text)).toEqual({ kind: "input", data: text });
    expect(parseTerminalMessage("{}")).toEqual({ kind: "input", data: "{}" });
  });
});

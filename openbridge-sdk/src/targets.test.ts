import { describe, it, expect } from "vitest";
import { parseOpenBridgeTarget, type OpenBridgeParsedTarget } from "./targets.js";

describe("parseOpenBridgeTarget", () => {
  describe("user: prefix (direct conversation)", () => {
    it("parses user: prefix correctly", () => {
      const result = parseOpenBridgeTarget("user:abc123");
      expect(result).toEqual({
        conversationId: "abc123",
        conversationType: "direct",
      });
    });

    it("parses user: prefix with whitespace", () => {
      const result = parseOpenBridgeTarget("user: abc123 ");
      expect(result).toEqual({
        conversationId: "abc123",
        conversationType: "direct",
      });
    });

    it("handles uppercase USER: prefix", () => {
      const result = parseOpenBridgeTarget("USER:abc123");
      expect(result).toEqual({
        conversationId: "abc123",
        conversationType: "direct",
      });
    });

    it("handles mixed case User: prefix", () => {
      const result = parseOpenBridgeTarget("User:abc123");
      expect(result).toEqual({
        conversationId: "abc123",
        conversationType: "direct",
      });
    });

    it("throws error when user: prefix has empty id", () => {
      expect(() => parseOpenBridgeTarget("user:")).toThrow("OpenBridge user target is empty");
      expect(() => parseOpenBridgeTarget("user:   ")).toThrow("OpenBridge user target is empty");
    });
  });

  describe("group: prefix (group conversation)", () => {
    it("parses group: prefix correctly", () => {
      const result = parseOpenBridgeTarget("group:xyz789");
      expect(result).toEqual({
        conversationId: "xyz789",
        conversationType: "group",
      });
    });

    it("parses group: prefix with whitespace", () => {
      const result = parseOpenBridgeTarget("group: xyz789 ");
      expect(result).toEqual({
        conversationId: "xyz789",
        conversationType: "group",
      });
    });

    it("handles uppercase GROUP: prefix", () => {
      const result = parseOpenBridgeTarget("GROUP:xyz789");
      expect(result).toEqual({
        conversationId: "xyz789",
        conversationType: "group",
      });
    });

    it("throws error when group: prefix has empty id", () => {
      expect(() => parseOpenBridgeTarget("group:")).toThrow("OpenBridge group target is empty");
      expect(() => parseOpenBridgeTarget("group:   ")).toThrow("OpenBridge group target is empty");
    });
  });

  describe("openbridge: prefix stripping", () => {
    it("strips openbridge: prefix", () => {
      const result = parseOpenBridgeTarget("openbridge:user:abc123");
      expect(result).toEqual({
        conversationId: "abc123",
        conversationType: "direct",
      });
    });

    it("strips openbridge: prefix from group target", () => {
      const result = parseOpenBridgeTarget("openbridge:group:xyz789");
      expect(result).toEqual({
        conversationId: "xyz789",
        conversationType: "group",
      });
    });

    it("strips openbridge: prefix from raw id", () => {
      const result = parseOpenBridgeTarget("openbridge:raw-id");
      expect(result).toEqual({
        conversationId: "raw-id",
        conversationType: "direct",
      });
    });

    it("handles uppercase OPENBRIDGE: prefix", () => {
      const result = parseOpenBridgeTarget("OPENBRIDGE:user:abc123");
      expect(result).toEqual({
        conversationId: "abc123",
        conversationType: "direct",
      });
    });

    it("handles mixed case prefix", () => {
      const result = parseOpenBridgeTarget("OpenBridge:user:abc123");
      expect(result).toEqual({
        conversationId: "abc123",
        conversationType: "direct",
      });
    });
  });

  describe("hobby-im: legacy prefix", () => {
    it("strips hobby-im: prefix", () => {
      const result = parseOpenBridgeTarget("hobby-im:user:abc123");
      expect(result).toEqual({
        conversationId: "abc123",
        conversationType: "direct",
      });
    });

    it("handles uppercase HOBBY-IM: prefix", () => {
      const result = parseOpenBridgeTarget("HOBBY-IM:group:xyz789");
      expect(result).toEqual({
        conversationId: "xyz789",
        conversationType: "group",
      });
    });
  });

  describe("raw id (no prefix)", () => {
    it("treats raw id as direct conversation", () => {
      const result = parseOpenBridgeTarget("simple-id");
      expect(result).toEqual({
        conversationId: "simple-id",
        conversationType: "direct",
      });
    });

    it("strips whitespace from raw id", () => {
      const result = parseOpenBridgeTarget("  simple-id  ");
      expect(result).toEqual({
        conversationId: "simple-id",
        conversationType: "direct",
      });
    });
  });

  describe("error handling", () => {
    it("throws error for empty string", () => {
      expect(() => parseOpenBridgeTarget("")).toThrow("OpenBridge target is empty");
    });

    it("throws error for whitespace only", () => {
      expect(() => parseOpenBridgeTarget("   ")).toThrow("OpenBridge target is empty");
    });

    it("throws error when openbridge: prefix leaves empty content", () => {
      expect(() => parseOpenBridgeTarget("openbridge:")).toThrow("OpenBridge target is empty");
      expect(() => parseOpenBridgeTarget("openbridge:   ")).toThrow("OpenBridge target is empty");
    });

    it("throws error when hobby-im: prefix leaves empty content", () => {
      expect(() => parseOpenBridgeTarget("hobby-im:")).toThrow("OpenBridge target is empty");
    });
  });

  describe("complex ids", () => {
    it("handles UUID-like ids", () => {
      const result = parseOpenBridgeTarget("user:a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      expect(result).toEqual({
        conversationId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        conversationType: "direct",
      });
    });

    it("handles ids with special characters", () => {
      const result = parseOpenBridgeTarget("user:test-id_123");
      expect(result).toEqual({
        conversationId: "test-id_123",
        conversationType: "direct",
      });
    });

    it("handles numeric ids", () => {
      const result = parseOpenBridgeTarget("group:12345");
      expect(result).toEqual({
        conversationId: "12345",
        conversationType: "group",
      });
    });
  });
});
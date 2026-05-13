import { describe, it, expect } from "vitest";
import { parseServerFrame, serializeClientFrame, type ClientFrame, type ServerFrame } from "./protocol.js";

describe("parseServerFrame", () => {
  describe("server.hello", () => {
    it("parses server.hello frame", () => {
      const result = parseServerFrame(JSON.stringify({ type: "server.hello" }));
      expect(result).toEqual({ type: "server.hello" });
    });
  });

  describe("server.pong", () => {
    it("parses server.pong frame with timestamp", () => {
      const result = parseServerFrame(JSON.stringify({ type: "server.pong", ts: 1234567890 }));
      expect(result).toEqual({ type: "server.pong", ts: 1234567890 });
    });

    it("uses current time when ts is missing", () => {
      const before = Date.now();
      const result = parseServerFrame(JSON.stringify({ type: "server.pong" }));
      const after = Date.now();
      expect(result.type).toBe("server.pong");
      expect(result.ts).toBeGreaterThanOrEqual(before);
      expect(result.ts).toBeLessThanOrEqual(after);
    });

    it("uses current time when ts is not a number", () => {
      const before = Date.now();
      const result = parseServerFrame(JSON.stringify({ type: "server.pong", ts: "invalid" }));
      const after = Date.now();
      expect(result.type).toBe("server.pong");
      expect(result.ts).toBeGreaterThanOrEqual(before);
      expect(result.ts).toBeLessThanOrEqual(after);
    });
  });

  describe("server.resync-required", () => {
    it("parses server.resync-required frame with reason", () => {
      const result = parseServerFrame(JSON.stringify({ type: "server.resync-required", reason: "device conflict" }));
      expect(result).toEqual({ type: "server.resync-required", reason: "device conflict" });
    });

    it("parses server.resync-required frame without reason", () => {
      const result = parseServerFrame(JSON.stringify({ type: "server.resync-required" }));
      expect(result).toEqual({ type: "server.resync-required", reason: undefined });
    });
  });

  describe("server.bye", () => {
    it("parses server.bye frame with reason", () => {
      const result = parseServerFrame(JSON.stringify({ type: "server.bye", reason: "server shutdown" }));
      expect(result).toEqual({ type: "server.bye", reason: "server shutdown" });
    });

    it("parses server.bye frame without reason", () => {
      const result = parseServerFrame(JSON.stringify({ type: "server.bye" }));
      expect(result).toEqual({ type: "server.bye", reason: undefined });
    });
  });

  describe("server.reply-ack", () => {
    it("parses server.reply-ack frame with all fields", () => {
      const result = parseServerFrame(JSON.stringify({
        type: "server.reply-ack",
        localId: "local-123",
        messageId: "msg-456",
        status: "delivered",
      }));
      expect(result).toEqual({
        type: "server.reply-ack",
        localId: "local-123",
        messageId: "msg-456",
        status: "delivered",
      });
    });

    it("parses server.reply-ack frame with missing fields", () => {
      const result = parseServerFrame(JSON.stringify({ type: "server.reply-ack" }));
      expect(result).toEqual({
        type: "server.reply-ack",
        localId: undefined,
        messageId: undefined,
        status: undefined,
      });
    });
  });

  describe("message frames", () => {
    it("parses message frame (legacy format)", () => {
      const message = {
        type: "message",
        eventId: "event-123",
        conversationId: "conv-456",
        conversationType: "direct",
        senderId: "sender-789",
        text: "Hello world",
      };
      const result = parseServerFrame(JSON.stringify(message));
      expect(result.type).toBe("message");
      expect(result).toMatchObject({
        eventId: "event-123",
        conversationId: "conv-456",
        conversationType: "direct",
        senderId: "sender-789",
        text: "Hello world",
      });
    });

    it("parses server.message frame (new format)", () => {
      const message = {
        type: "server.message",
        eventId: "event-123",
        conversationId: "conv-456",
        conversationType: "group",
        senderId: "sender-789",
        text: "Hello world",
      };
      const result = parseServerFrame(JSON.stringify(message));
      expect(result.type).toBe("message");
      expect(result).toMatchObject({
        eventId: "event-123",
        conversationId: "conv-456",
        conversationType: "group",
      });
    });

    it("parses message frame with media", () => {
      const message = {
        type: "message",
        eventId: "event-123",
        conversationId: "conv-456",
        conversationType: "direct",
        senderId: "sender-789",
        text: "",
        media: [
          { kind: "image", url: "https://example.com/image.png" },
          { kind: "file", url: "https://example.com/file.pdf", fileName: "doc.pdf" },
        ],
      };
      const result = parseServerFrame(JSON.stringify(message));
      expect(result.media).toBeDefined();
      expect(result.media?.length).toBe(2);
    });

    it("parses message frame with all optional fields", () => {
      const message = {
        type: "message",
        eventId: "event-123",
        sequence: 42,
        conversationId: "conv-456",
        conversationType: "direct",
        senderId: "sender-789",
        senderName: "John Doe",
        text: "Hello",
        timestamp: 1234567890,
        replyToId: "reply-to-id",
        threadId: "thread-id",
        metadata: { foo: "bar" },
      };
      const result = parseServerFrame(JSON.stringify(message));
      expect(result).toMatchObject({
        sequence: 42,
        senderName: "John Doe",
        timestamp: 1234567890,
        replyToId: "reply-to-id",
        threadId: "thread-id",
      });
    });
  });

  describe("error handling", () => {
    it("throws error for unknown frame type", () => {
      expect(() => parseServerFrame(JSON.stringify({ type: "unknown" })))
        .toThrow("unsupported openbridge server frame: unknown");
    });

    it("throws error for missing type", () => {
      expect(() => parseServerFrame(JSON.stringify({ foo: "bar" })))
        .toThrow("unsupported openbridge server frame: unknown");
    });

    it("throws error for invalid JSON", () => {
      expect(() => parseServerFrame("not valid json")).toThrow();
    });

    it("throws error for non-object input", () => {
      expect(() => parseServerFrame(JSON.stringify("string")))
        .toThrow("unsupported openbridge server frame: unknown");
    });

    it("throws error for null input", () => {
      expect(() => parseServerFrame(JSON.stringify(null)))
        .toThrow("unsupported openbridge server frame: unknown");
    });
  });
});

describe("serializeClientFrame", () => {
  it("serializes client.hello frame", () => {
    const frame: ClientFrame = {
      type: "client.hello",
      protocolVersion: 2,
      deviceId: "device-123",
      clientId: "client-456",
      accountId: "account-789",
      timestamp: 1234567890,
      nonce: "nonce-abc",
      signature: "sig-def",
    };
    const result = serializeClientFrame(frame);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual(frame);
  });

  it("serializes client.hello frame with optional fields", () => {
    const frame: ClientFrame = {
      type: "client.hello",
      protocolVersion: 2,
      deviceId: "device-123",
      clientId: "client-456",
      accountId: "account-789",
      timestamp: 1234567890,
      nonce: "nonce-abc",
      signature: "sig-def",
      lastProcessedSequence: 100,
      lastProcessedEventId: "event-999",
    };
    const result = serializeClientFrame(frame);
    const parsed = JSON.parse(result);
    expect(parsed.lastProcessedSequence).toBe(100);
    expect(parsed.lastProcessedEventId).toBe("event-999");
  });

  it("serializes client.ping frame", () => {
    const frame: ClientFrame = {
      type: "client.ping",
      ts: 1234567890,
    };
    const result = serializeClientFrame(frame);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual(frame);
  });

  it("serializes client.ack frame with received status", () => {
    const frame: ClientFrame = {
      type: "client.ack",
      eventId: "event-123",
      status: "received",
    };
    const result = serializeClientFrame(frame);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual(frame);
  });

  it("serializes client.ack frame with error", () => {
    const frame: ClientFrame = {
      type: "client.ack",
      eventId: "event-123",
      status: "failed",
      error: "Something went wrong",
    };
    const result = serializeClientFrame(frame);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toBe("Something went wrong");
  });

  it("serializes client.ack frame with duplicate status", () => {
    const frame: ClientFrame = {
      type: "client.ack",
      eventId: "event-123",
      status: "duplicate",
    };
    const result = serializeClientFrame(frame);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("duplicate");
  });

  it("serializes client.reply frame", () => {
    const frame: ClientFrame = {
      type: "client.reply",
      reply: {
        localId: "local-123",
        conversationId: "conv-456",
        conversationType: "direct",
        text: "Reply text",
        createdAt: 1234567890,
      },
    };
    const result = serializeClientFrame(frame);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("client.reply");
    expect(parsed.reply.localId).toBe("local-123");
    expect(parsed.reply.text).toBe("Reply text");
  });

  it("serializes client.reply frame with media", () => {
    const frame: ClientFrame = {
      type: "client.reply",
      reply: {
        localId: "local-123",
        eventId: "event-456",
        conversationId: "conv-789",
        conversationType: "group",
        text: "",
        media: [{ kind: "image", url: "https://example.com/img.png" }],
        replyToId: "reply-to",
        threadId: "thread-1",
        createdAt: 1234567890,
      },
    };
    const result = serializeClientFrame(frame);
    const parsed = JSON.parse(result);
    expect(parsed.reply.media.length).toBe(1);
    expect(parsed.reply.replyToId).toBe("reply-to");
    expect(parsed.reply.threadId).toBe("thread-1");
  });

  it("produces valid JSON for all frame types", () => {
    const frames: ClientFrame[] = [
      { type: "client.hello", protocolVersion: 2, deviceId: "d", clientId: "c", accountId: "a", timestamp: 1, nonce: "n", signature: "s" },
      { type: "client.ping", ts: 1 },
      { type: "client.ack", eventId: "e", status: "processed" },
      { type: "client.reply", reply: { localId: "l", conversationId: "c", conversationType: "direct", text: "t", createdAt: 1 } },
    ];

    for (const frame of frames) {
      const result = serializeClientFrame(frame);
      expect(() => JSON.parse(result)).not.toThrow();
    }
  });
});
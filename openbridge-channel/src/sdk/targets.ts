import type { SpringImConversationType } from "./types.js";

export type OpenBridgeParsedTarget = {
  conversationId: string;
  conversationType: SpringImConversationType;
};

export function parseOpenBridgeTarget(rawTarget: string): OpenBridgeParsedTarget {
  const raw = rawTarget.trim().replace(/^openbridge:/i, "").replace(/^hobby-im:/i, "");
  if (!raw) {
    throw new Error("OpenBridge target is empty");
  }
  if (raw.toLowerCase().startsWith("user:")) {
    const id = raw.slice("user:".length).trim();
    if (!id) {
      throw new Error("OpenBridge user target is empty");
    }
    return { conversationId: id, conversationType: "direct" };
  }
  if (raw.toLowerCase().startsWith("group:")) {
    const id = raw.slice("group:".length).trim();
    if (!id) {
      throw new Error("OpenBridge group target is empty");
    }
    return { conversationId: id, conversationType: "group" };
  }
  return { conversationId: raw, conversationType: "direct" };
}

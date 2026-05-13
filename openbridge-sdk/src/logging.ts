import type {
  SpringImCloudMessage,
  SpringImMediaItem,
  SpringImReply,
} from "./types.js";
import type { ClientFrame, ServerFrame } from "./protocol.js";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function previewText(text: string | undefined, maxLength = 120): string {
  const compact = compactWhitespace(text ?? "");
  if (!compact) {
    return "(empty)";
  }
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

export function summarizeMedia(media: SpringImMediaItem[] | undefined): string {
  if (!media?.length) {
    return "media=0";
  }
  const counts = media.reduce<Record<string, number>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1;
    return acc;
  }, {});
  const detail = Object.entries(counts)
    .map(([kind, count]) => `${kind}:${count}`)
    .join(",");
  return `media=${media.length}(${detail})`;
}

export function summarizeCloudMessage(message: SpringImCloudMessage): string {
  return [
    `eventId=${message.eventId}`,
    `sequence=${message.sequence ?? "n/a"}`,
    `conversation=${message.conversationType}:${message.conversationId}`,
    `sender=${message.senderId}`,
    `replyTo=${message.replyToId ?? "n/a"}`,
    `thread=${message.threadId ?? "n/a"}`,
    summarizeMedia(message.media),
    `text="${previewText(message.text)}"`,
  ].join(" ");
}

export function summarizeReply(reply: SpringImReply): string {
  return [
    `localId=${reply.localId}`,
    `eventId=${reply.eventId ?? "n/a"}`,
    `conversation=${reply.conversationType}:${reply.conversationId}`,
    `replyTo=${reply.replyToId ?? "n/a"}`,
    `thread=${reply.threadId ?? "n/a"}`,
    summarizeMedia(reply.media),
    `text="${previewText(reply.text)}"`,
  ].join(" ");
}

export function summarizeClientFrame(frame: ClientFrame): string {
  switch (frame.type) {
    case "client.hello":
      return [
        `type=${frame.type}`,
        `clientId=${frame.clientId}`,
        `accountId=${frame.accountId}`,
        `deviceId=${frame.deviceId}`,
        `protocolVersion=${frame.protocolVersion}`,
      ].join(" ");
    case "client.ping":
      return `type=${frame.type} ts=${frame.ts}`;
    case "client.ack":
      return [
        `type=${frame.type}`,
        `eventId=${frame.eventId}`,
        `status=${frame.status}`,
        `error=${previewText(frame.error, 80)}`,
      ].join(" ");
    case "client.reply":
      return `type=${frame.type} ${summarizeReply(frame.reply)}`;
    default:
      return `type=${(frame as { type?: string }).type ?? "unknown"}`;
  }
}

export function summarizeServerFrame(frame: ServerFrame): string {
  switch (frame.type) {
    case "server.hello":
      return `type=${frame.type}`;
    case "server.pong":
      return `type=${frame.type} ts=${frame.ts}`;
    case "server.resync-required":
      return `type=${frame.type} reason=${previewText(frame.reason, 80)}`;
    case "server.bye":
      return `type=${frame.type} reason=${previewText(frame.reason, 80)}`;
    case "server.reply-ack":
      return [
        `type=${frame.type}`,
        `localId=${frame.localId ?? "n/a"}`,
        `messageId=${frame.messageId ?? "n/a"}`,
        `status=${frame.status ?? "n/a"}`,
      ].join(" ");
    case "message":
      return `type=${frame.type} ${summarizeCloudMessage(frame)}`;
    default:
      return `type=${(frame as { type?: string }).type ?? "unknown"}`;
  }
}

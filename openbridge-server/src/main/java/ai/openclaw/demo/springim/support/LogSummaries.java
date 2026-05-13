package ai.openclaw.demo.springim.support;

import ai.openclaw.demo.springim.dto.OpenClawRestDtos.ReplyRequest;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.UserMessageRequest;
import ai.openclaw.demo.springim.model.ImEvent;
import ai.openclaw.demo.springim.model.MediaItem;
import ai.openclaw.demo.springim.model.OpenClawReply;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class LogSummaries {
    private LogSummaries() {
    }

    public static Map<String, Object> summarizeUserMessage(String conversationId, String clientId, UserMessageRequest request) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("clientId", blankToEmpty(clientId));
        summary.put("conversationId", blankToEmpty(conversationId));
        summary.put("conversationType", String.valueOf(request.conversationType()));
        summary.put("senderId", blankToEmpty(request.senderId()));
        summary.put("senderName", blankToEmpty(request.senderName()));
        summary.put("textPreview", preview(request.text()));
        summary.put("textLength", request.text() == null ? 0 : request.text().length());
        summary.put("media", summarizeMedia(request.media()));
        return summary;
    }

    public static Map<String, Object> summarizeEvent(ImEvent event) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("eventId", blankToEmpty(event.eventId()));
        summary.put("clientId", blankToEmpty(event.clientId()));
        summary.put("conversationId", blankToEmpty(event.conversationId()));
        summary.put("conversationType", String.valueOf(event.conversationType()));
        summary.put("senderId", blankToEmpty(event.senderId()));
        summary.put("senderName", blankToEmpty(event.senderName()));
        summary.put("status", String.valueOf(event.status()));
        summary.put("textPreview", preview(event.text()));
        summary.put("textLength", event.text() == null ? 0 : event.text().length());
        summary.put("media", summarizeMedia(event.media()));
        return summary;
    }

    public static Map<String, Object> summarizeReply(OpenClawReply reply) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("localId", blankToEmpty(reply.localId()));
        summary.put("eventId", blankToEmpty(reply.eventId()));
        summary.put("conversationId", blankToEmpty(reply.conversationId()));
        summary.put("conversationType", String.valueOf(reply.conversationType()));
        summary.put("replyToId", blankToEmpty(reply.replyToId()));
        summary.put("threadId", blankToEmpty(reply.threadId()));
        summary.put("textPreview", preview(reply.text()));
        summary.put("textLength", reply.text() == null ? 0 : reply.text().length());
        summary.put("media", summarizeMedia(reply.media()));
        return summary;
    }

    public static Map<String, Object> summarizeReplyRequest(ReplyRequest request) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("localId", blankToEmpty(request.localId()));
        summary.put("eventId", blankToEmpty(request.eventId()));
        summary.put("conversationId", blankToEmpty(request.conversationId()));
        summary.put("conversationType", String.valueOf(request.conversationType()));
        summary.put("replyToId", blankToEmpty(request.replyToId()));
        summary.put("threadId", blankToEmpty(request.threadId()));
        summary.put("textPreview", preview(request.text()));
        summary.put("textLength", request.text() == null ? 0 : request.text().length());
        summary.put("media", summarizeMedia(request.media()));
        return summary;
    }

    public static Map<String, Object> summarizeMedia(List<MediaItem> media) {
        if (media == null || media.isEmpty()) {
            return Map.of("count", 0);
        }
        MediaItem first = media.get(0);
        return Map.of(
                "count", media.size(),
                "firstKind", blankToEmpty(first.kind()),
                "firstName", blankToEmpty(first.fileName()),
                "firstMimeType", blankToEmpty(first.mimeType()),
                "firstSize", first.size() == null ? 0L : first.size()
        );
    }

    private static String preview(String text) {
        if (text == null) {
            return "";
        }
        String normalized = text.replaceAll("\\s+", " ").trim();
        if (normalized.length() <= 120) {
            return normalized;
        }
        return normalized.substring(0, 117) + "...";
    }

    private static String blankToEmpty(String value) {
        return value == null ? "" : value;
    }
}

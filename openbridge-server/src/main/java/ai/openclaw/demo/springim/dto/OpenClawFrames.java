package ai.openclaw.demo.springim.dto;

import ai.openclaw.demo.springim.model.ConversationType;
import ai.openclaw.demo.springim.model.MediaItem;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.Map;

public final class OpenClawFrames {
    private OpenClawFrames() {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ClientHello(
            String type,
            String clientId,
            String accountId,
            Integer protocolVersion
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ClientAck(
            String type,
            String eventId,
            String status,
            String error
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ClientReply(
            String type,
            ReplyPayload reply
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ReplyPayload(
            String localId,
            String eventId,
            String conversationId,
            ConversationType conversationType,
            String text,
            java.util.List<MediaItem> media,
            String replyToId,
            String threadId,
            Long createdAt
    ) {
    }

    public record ServerHello(
            String type
    ) {
        public static ServerHello of() {
            return new ServerHello("server.hello");
        }
    }

    public record ServerBye(
            String type,
            String reason
    ) {
        public static ServerBye shutdown() {
            return new ServerBye("server.bye", "shutdown");
        }
    }

    public record ServerReplyAck(
            String type,
            String localId,
            String status
    ) {
        public static ServerReplyAck saved(String localId) {
            return new ServerReplyAck("server.reply-ack", localId, "saved");
        }

        public static ServerReplyAck failed(String localId) {
            return new ServerReplyAck("server.reply-ack", localId, "failed");
        }
    }

    public record ServerMessage(
            String type,
            String eventId,
            long sequence,
            String conversationId,
            ConversationType conversationType,
            String senderId,
            String senderName,
            String text,
            java.util.List<MediaItem> media,
            long timestamp,
            String replyToId,
            String threadId,
            Map<String, Object> metadata
    ) {
    }
}

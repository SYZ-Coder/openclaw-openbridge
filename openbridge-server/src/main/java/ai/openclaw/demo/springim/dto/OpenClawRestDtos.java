package ai.openclaw.demo.springim.dto;

import ai.openclaw.demo.springim.model.ConversationType;
import ai.openclaw.demo.springim.model.MediaItem;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.List;

public final class OpenClawRestDtos {
    private OpenClawRestDtos() {
    }

    public record ReplyRequest(
            @NotBlank String localId,
            String eventId,
            @NotBlank String conversationId,
            ConversationType conversationType,
            String text,
            List<MediaItem> media,
            String replyToId,
            String threadId,
            Long createdAt
    ) {
    }

    public record UserMessageRequest(
            String clientId,
            ConversationType conversationType,
            @NotBlank String senderId,
            String senderName,
            @NotBlank String text,
            List<MediaItem> media
    ) {
    }

    public record EventView(
            String eventId,
            String clientId,
            String conversationId,
            ConversationType conversationType,
            String senderId,
            String senderName,
            String text,
            List<MediaItem> media,
            String status,
            String lastError,
            Instant createdAt,
            Instant processedAt
    ) {
    }

    public record ReplyView(
            String localId,
            String eventId,
            String conversationId,
            ConversationType conversationType,
            String text,
            List<MediaItem> media,
            Instant createdAt,
            Instant receivedAt
    ) {
    }

    public record ConversationView(
            String conversationId,
            List<EventView> userMessages,
            List<ReplyView> openClawReplies
    ) {
    }
}

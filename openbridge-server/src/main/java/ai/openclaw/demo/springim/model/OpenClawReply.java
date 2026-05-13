package ai.openclaw.demo.springim.model;

import java.time.Instant;
import java.util.List;

public record OpenClawReply(
        String localId,
        String eventId,
        String conversationId,
        ConversationType conversationType,
        String text,
        List<MediaItem> media,
        String replyToId,
        String threadId,
        Instant createdAt,
        Instant receivedAt
) {
}

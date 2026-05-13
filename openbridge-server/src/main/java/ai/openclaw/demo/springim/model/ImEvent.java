package ai.openclaw.demo.springim.model;

import java.time.Instant;
import java.util.List;
import java.util.Map;

public record ImEvent(
        long id,
        String eventId,
        String clientId,
        String conversationId,
        ConversationType conversationType,
        String senderId,
        String senderName,
        String text,
        List<MediaItem> media,
        EventStatus status,
        String lastError,
        Instant createdAt,
        Instant updatedAt,
        Instant processedAt,
        String deliverySessionId,
        Instant deliveryLeaseUntil,
        Map<String, Object> metadata
) {
    public ImEvent withStatus(EventStatus nextStatus, String error) {
        Instant now = Instant.now();
        String nextDeliverySessionId = nextStatus == EventStatus.processed || nextStatus == EventStatus.failed
                ? null
                : deliverySessionId;
        Instant nextDeliveryLeaseUntil = nextStatus == EventStatus.processed || nextStatus == EventStatus.failed
                ? null
                : deliveryLeaseUntil;
        return new ImEvent(
                id,
                eventId,
                clientId,
                conversationId,
                conversationType,
                senderId,
                senderName,
                text,
                media,
                nextStatus,
                error,
                createdAt,
                now,
                nextStatus == EventStatus.processed ? now : processedAt,
                nextDeliverySessionId,
                nextDeliveryLeaseUntil,
                metadata
        );
    }

    public ImEvent withLease(String sessionId, Instant leaseUntil) {
        Instant now = Instant.now();
        return new ImEvent(
                id,
                eventId,
                clientId,
                conversationId,
                conversationType,
                senderId,
                senderName,
                text,
                media,
                status,
                lastError,
                createdAt,
                now,
                processedAt,
                sessionId,
                leaseUntil,
                metadata
        );
    }

    public ImEvent requeue(String error) {
        Instant now = Instant.now();
        return new ImEvent(
                id,
                eventId,
                clientId,
                conversationId,
                conversationType,
                senderId,
                senderName,
                text,
                media,
                EventStatus.pending,
                error,
                createdAt,
                now,
                processedAt,
                null,
                null,
                metadata
        );
    }
}

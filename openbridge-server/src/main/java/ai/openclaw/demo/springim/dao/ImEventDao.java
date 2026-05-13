package ai.openclaw.demo.springim.dao;

import ai.openclaw.demo.springim.model.ConversationType;
import ai.openclaw.demo.springim.model.EventStatus;
import ai.openclaw.demo.springim.model.ImEvent;
import ai.openclaw.demo.springim.model.MediaItem;
import java.time.Instant;
import java.util.List;

/**
 * Data Access Object for IM events.
 *
 * Provides CRUD operations for the im_events table.
 */
public interface ImEventDao {

    /**
     * Insert a new event.
     */
    ImEvent insert(ImEvent event);

    /**
     * Update event status.
     */
    ImEvent updateStatus(String eventId, EventStatus status, String error);

    /**
     * Update delivery lease.
     */
    ImEvent updateLease(String eventId, String sessionId, Instant leaseUntil);

    /**
     * Requeue event to pending status.
     */
    ImEvent requeue(String eventId, String error);

    /**
     * Find event by eventId.
     */
    ImEvent findByEventId(String eventId);

    /**
     * Find all events for a client.
     */
    List<ImEvent> findByClientId(String clientId);

    /**
     * Find all events for a conversation.
     */
    List<ImEvent> findByConversationId(String conversationId);

    /**
     * Find deliverable (pending) events for a client.
     */
    List<ImEvent> findDeliverableByClientId(String clientId, int limit);

    /**
     * Find all client IDs that have pending events.
     */
    List<String> findPendingClientIds();

    /**
     * Find stale leases (delivery_lease_until < cutoff).
     */
    List<StaleLease> findStaleLeases(Instant cutoff);

    /**
     * Find all events.
     */
    List<ImEvent> findAll();

    /**
     * Requeue all events for a session.
     */
    int requeueBySession(String clientId, String sessionId, String error);

    /**
     * Sweep all stale leases.
     */
    int sweepStaleLeases(Instant cutoff);

    /**
     * Get next sequence number.
     */
    long nextSequence();

    /**
     * Create a new user message event.
     */
    ImEvent createUserMessage(
            String clientId,
            String conversationId,
            ConversationType conversationType,
            String senderId,
            String senderName,
            String text,
            List<MediaItem> media
    );

    /**
     * Mark event as processed from reply.
     */
    ImEvent markProcessedFromReply(String eventId);

    /**
     * Record for stale lease information.
     */
    record StaleLease(String eventId, String clientId, String sessionId) {}
}
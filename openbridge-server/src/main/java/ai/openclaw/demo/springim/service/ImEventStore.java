package ai.openclaw.demo.springim.service;

import ai.openclaw.demo.springim.dao.ImEventDao;
import ai.openclaw.demo.springim.model.ConversationType;
import ai.openclaw.demo.springim.model.EventStatus;
import ai.openclaw.demo.springim.model.ImEvent;
import ai.openclaw.demo.springim.model.MediaItem;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Event store service using SQLite database.
 *
 * All persistence operations are delegated to ImEventDao.
 * This service provides the same interface as the original JSON-based implementation.
 */
@Service
public class ImEventStore {
    private static final Logger log = LoggerFactory.getLogger(ImEventStore.class);

    private final ImEventDao eventDao;

    /**
     * Stale lease record for identifying events with expired delivery leases.
     */
    public record StaleLease(String eventId, String clientId, String sessionId) {}

    public ImEventStore(ImEventDao eventDao) {
        this.eventDao = eventDao;
        log.info("ImEventStore initialized with SQLite DAO");
    }

    public ImEvent createUserMessage(
            String clientId,
            String conversationId,
            ConversationType conversationType,
            String senderId,
            String senderName,
            String text,
            List<MediaItem> media
    ) {
        ImEvent event = eventDao.createUserMessage(
                clientId, conversationId, conversationType,
                senderId, senderName, text, media
        );
        log.info("User message created: eventId={} clientId={} conversationId={} status={}",
                event.eventId(), event.clientId(), event.conversationId(), event.status());
        return event;
    }

    public ImEvent markAck(String eventId, String status, String error, String sessionId) {
        EventStatus nextStatus;
        if ("processed".equals(status) || "duplicate".equals(status)) {
            nextStatus = EventStatus.processed;
        } else if ("failed".equals(status)) {
            nextStatus = EventStatus.failed;
        } else {
            ImEvent existing = eventDao.findByEventId(eventId);
            if (existing != null && existing.status() == EventStatus.processed) {
                nextStatus = EventStatus.processed;
            } else {
                nextStatus = EventStatus.received;
            }
        }

        ImEvent updated = eventDao.updateStatus(eventId, nextStatus, error);
        if (updated != null) {
            log.info("Event status updated: eventId={} status={} error={}", eventId, nextStatus, error);

            // Set lease for received status
            if (nextStatus == EventStatus.received && sessionId != null && !sessionId.isBlank()) {
                updated = eventDao.updateLease(eventId, sessionId, Instant.now().plusSeconds(15));
            }
        }
        return updated;
    }

    public ImEvent markProcessedFromReply(String eventId) {
        ImEvent updated = eventDao.markProcessedFromReply(eventId);
        if (updated != null) {
            log.info("Event marked processed from reply: eventId={}", eventId);
        }
        return updated;
    }

    public ImEvent markLeased(String eventId, String sessionId, Instant leaseUntil) {
        ImEvent updated = eventDao.updateLease(eventId, sessionId, leaseUntil);
        if (updated != null) {
            log.info("Event leased: eventId={} sessionId={} leaseUntil={}", eventId, sessionId, leaseUntil);
        }
        return updated;
    }

    public int requeueSessionEvents(String clientId, String sessionId, String error) {
        if (sessionId == null || sessionId.isBlank()) {
            return 0;
        }
        int changed = eventDao.requeueBySession(clientId, sessionId, error);
        if (changed > 0) {
            log.info("Session events requeued: clientId={} sessionId={} count={}", clientId, sessionId, changed);
        }
        return changed;
    }

    public int sweepStaleLeases(Instant cutoff) {
        int changed = eventDao.sweepStaleLeases(cutoff);
        if (changed > 0) {
            log.info("Stale leases swept: cutoff={} count={}", cutoff, changed);
        }
        return changed;
    }

    public List<StaleLease> findStaleLeases(Instant cutoff) {
        List<ImEventDao.StaleLease> daoLeases = eventDao.findStaleLeases(cutoff);
        return daoLeases.stream()
                .map(l -> new StaleLease(l.eventId(), l.clientId(), l.sessionId()))
                .toList();
    }

    public List<ImEvent> findDeliverableEvents(String clientId, int limit) {
        return eventDao.findDeliverableByClientId(clientId, limit);
    }

    public List<String> findPendingClientIds() {
        return eventDao.findPendingClientIds();
    }

    public List<ImEvent> findConversationEvents(String conversationId) {
        return eventDao.findByConversationId(conversationId);
    }

    public List<ImEvent> findAll() {
        return eventDao.findAll();
    }
}
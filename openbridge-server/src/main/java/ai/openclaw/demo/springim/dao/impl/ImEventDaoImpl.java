package ai.openclaw.demo.springim.dao.impl;

import ai.openclaw.demo.springim.dao.ImEventDao;
import ai.openclaw.demo.springim.model.ConversationType;
import ai.openclaw.demo.springim.model.EventStatus;
import ai.openclaw.demo.springim.model.ImEvent;
import ai.openclaw.demo.springim.model.MediaItem;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * JDBC implementation of ImEventDao using SQLite.
 */
@Repository
public class ImEventDaoImpl implements ImEventDao {
    private static final Logger log = LoggerFactory.getLogger(ImEventDaoImpl.class);

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final AtomicLong sequenceCache = new AtomicLong(0);

    private static final String INSERT_SQL =
            "INSERT INTO im_events (id, event_id, client_id, conversation_id, conversation_type, " +
            "sender_id, sender_name, text, media_json, status, last_error, " +
            "created_at, updated_at, processed_at, delivery_session_id, delivery_lease_until, metadata_json) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

    private static final String UPDATE_STATUS_SQL =
            "UPDATE im_events SET status = ?, last_error = ?, updated_at = ?, " +
            "delivery_session_id = ?, delivery_lease_until = ?, processed_at = ? WHERE event_id = ?";

    private static final String UPDATE_LEASE_SQL =
            "UPDATE im_events SET delivery_session_id = ?, delivery_lease_until = ?, updated_at = ? WHERE event_id = ?";

    private static final String REQUEUE_SQL =
            "UPDATE im_events SET status = 'pending', last_error = ?, updated_at = ?, " +
            "delivery_session_id = NULL, delivery_lease_until = NULL WHERE event_id = ?";

    private static final String FIND_BY_EVENT_ID_SQL = "SELECT * FROM im_events WHERE event_id = ?";

    private static final String FIND_BY_CLIENT_ID_SQL = "SELECT * FROM im_events WHERE client_id = ? ORDER BY id ASC";

    private static final String FIND_BY_CONVERSATION_ID_SQL = "SELECT * FROM im_events WHERE conversation_id = ? ORDER BY id ASC";

    private static final String FIND_DELIVERABLE_SQL =
            "SELECT * FROM im_events WHERE client_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?";

    private static final String FIND_PENDING_CLIENT_IDS_SQL = "SELECT DISTINCT client_id FROM im_events WHERE status = 'pending'";

    private static final String FIND_STALE_LEASES_SQL =
            "SELECT event_id, client_id, delivery_session_id FROM im_events " +
            "WHERE status NOT IN ('processed', 'failed') AND delivery_lease_until IS NOT NULL AND delivery_lease_until < ?";

    private static final String FIND_ALL_SQL = "SELECT * FROM im_events ORDER BY id ASC";

    private static final String REQUEUE_BY_SESSION_SQL =
            "UPDATE im_events SET status = 'pending', last_error = ?, updated_at = ?, " +
            "delivery_session_id = NULL, delivery_lease_until = NULL " +
            "WHERE client_id = ? AND delivery_session_id = ? AND status NOT IN ('processed', 'failed')";

    private static final String SWEEP_STALE_LEASES_SQL =
            "UPDATE im_events SET status = 'pending', last_error = 'stale-lease', updated_at = ?, " +
            "delivery_session_id = NULL, delivery_lease_until = NULL " +
            "WHERE status NOT IN ('processed', 'failed') AND delivery_lease_until IS NOT NULL AND delivery_lease_until < ?";

    private static final String NEXT_SEQUENCE_SQL =
            "UPDATE sequences SET next_val = next_val + 1 WHERE sequence_name = 'im_events'";

    private static final String GET_SEQUENCE_SQL = "SELECT next_val FROM sequences WHERE sequence_name = 'im_events'";

    private final RowMapper<ImEvent> rowMapper = (rs, rowNum) -> {
        long id = rs.getLong("id");
        String eventId = rs.getString("event_id");
        String clientId = rs.getString("client_id");
        String conversationId = rs.getString("conversation_id");
        ConversationType conversationType = ConversationType.valueOf(rs.getString("conversation_type"));
        String senderId = rs.getString("sender_id");
        String senderName = rs.getString("sender_name");
        String text = rs.getString("text");
        List<MediaItem> media = parseMedia(rs.getString("media_json"));
        EventStatus status = EventStatus.valueOf(rs.getString("status"));
        String lastError = rs.getString("last_error");
        Instant createdAt = Instant.ofEpochMilli(rs.getLong("created_at"));
        Instant updatedAt = Instant.ofEpochMilli(rs.getLong("updated_at"));
        long processedAtRaw = rs.getLong("processed_at");
        Instant processedAt = processedAtRaw > 0 ? Instant.ofEpochMilli(processedAtRaw) : null;
        String deliverySessionId = rs.getString("delivery_session_id");
        long leaseUntilRaw = rs.getLong("delivery_lease_until");
        Instant deliveryLeaseUntil = leaseUntilRaw > 0 ? Instant.ofEpochMilli(leaseUntilRaw) : null;
        Map<String, Object> metadata = parseMetadata(rs.getString("metadata_json"));

        return new ImEvent(
                id, eventId, clientId, conversationId, conversationType,
                senderId, senderName, text, media, status, lastError,
                createdAt, updatedAt, processedAt, deliverySessionId, deliveryLeaseUntil, metadata
        );
    };

    public ImEventDaoImpl(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        initSequence();
    }

    private void initSequence() {
        try {
            Long current = jdbcTemplate.queryForObject(GET_SEQUENCE_SQL, Long.class);
            if (current != null) {
                sequenceCache.set(current);
            }
        } catch (Exception e) {
            log.warn("Failed to initialize sequence: {}", e.getMessage());
            sequenceCache.set(1);
        }
    }

    @Override
    public ImEvent insert(ImEvent event) {
        jdbcTemplate.update(INSERT_SQL,
                event.id(),
                event.eventId(),
                event.clientId(),
                event.conversationId(),
                event.conversationType().name(),
                event.senderId(),
                event.senderName(),
                event.text(),
                toJson(event.media()),
                event.status().name(),
                event.lastError(),
                event.createdAt().toEpochMilli(),
                event.updatedAt().toEpochMilli(),
                event.processedAt() != null ? event.processedAt().toEpochMilli() : null,
                event.deliverySessionId(),
                event.deliveryLeaseUntil() != null ? event.deliveryLeaseUntil().toEpochMilli() : null,
                toJson(event.metadata())
        );
        return event;
    }

    @Override
    public ImEvent updateStatus(String eventId, EventStatus status, String error) {
        ImEvent existing = findByEventId(eventId);
        if (existing == null) {
            return null;
        }
        Instant now = Instant.now();
        String sessionId = (status == EventStatus.processed || status == EventStatus.failed) ? null : existing.deliverySessionId();
        Instant leaseUntil = (status == EventStatus.processed || status == EventStatus.failed) ? null : existing.deliveryLeaseUntil();
        Instant processedAt = (status == EventStatus.processed) ? now : existing.processedAt();

        jdbcTemplate.update(UPDATE_STATUS_SQL,
                status.name(),
                error,
                now.toEpochMilli(),
                sessionId,
                leaseUntil != null ? leaseUntil.toEpochMilli() : null,
                processedAt != null ? processedAt.toEpochMilli() : null,
                eventId
        );

        return new ImEvent(
                existing.id(), eventId, existing.clientId(), existing.conversationId(),
                existing.conversationType(), existing.senderId(), existing.senderName(),
                existing.text(), existing.media(), status, error,
                existing.createdAt(), now, processedAt, sessionId, leaseUntil, existing.metadata()
        );
    }

    @Override
    public ImEvent updateLease(String eventId, String sessionId, Instant leaseUntil) {
        ImEvent existing = findByEventId(eventId);
        if (existing == null) {
            return null;
        }
        Instant now = Instant.now();
        jdbcTemplate.update(UPDATE_LEASE_SQL,
                sessionId,
                leaseUntil.toEpochMilli(),
                now.toEpochMilli(),
                eventId
        );

        return new ImEvent(
                existing.id(), eventId, existing.clientId(), existing.conversationId(),
                existing.conversationType(), existing.senderId(), existing.senderName(),
                existing.text(), existing.media(), existing.status(), existing.lastError(),
                existing.createdAt(), now, existing.processedAt(), sessionId, leaseUntil, existing.metadata()
        );
    }

    @Override
    public ImEvent requeue(String eventId, String error) {
        ImEvent existing = findByEventId(eventId);
        if (existing == null) {
            return null;
        }
        Instant now = Instant.now();
        jdbcTemplate.update(REQUEUE_SQL, error, now.toEpochMilli(), eventId);

        return new ImEvent(
                existing.id(), eventId, existing.clientId(), existing.conversationId(),
                existing.conversationType(), existing.senderId(), existing.senderName(),
                existing.text(), existing.media(), EventStatus.pending, error,
                existing.createdAt(), now, existing.processedAt(), null, null, existing.metadata()
        );
    }

    @Override
    public ImEvent findByEventId(String eventId) {
        List<ImEvent> results = jdbcTemplate.query(FIND_BY_EVENT_ID_SQL, rowMapper, eventId);
        return results.isEmpty() ? null : results.get(0);
    }

    @Override
    public List<ImEvent> findByClientId(String clientId) {
        return jdbcTemplate.query(FIND_BY_CLIENT_ID_SQL, rowMapper, clientId);
    }

    @Override
    public List<ImEvent> findByConversationId(String conversationId) {
        return jdbcTemplate.query(FIND_BY_CONVERSATION_ID_SQL, rowMapper, conversationId);
    }

    @Override
    public List<ImEvent> findDeliverableByClientId(String clientId, int limit) {
        return jdbcTemplate.query(FIND_DELIVERABLE_SQL, rowMapper, clientId, limit);
    }

    @Override
    public List<String> findPendingClientIds() {
        return jdbcTemplate.queryForList(FIND_PENDING_CLIENT_IDS_SQL, String.class);
    }

    @Override
    public List<StaleLease> findStaleLeases(Instant cutoff) {
        return jdbcTemplate.query(FIND_STALE_LEASES_SQL,
                (rs, rowNum) -> new StaleLease(
                        rs.getString("event_id"),
                        rs.getString("client_id"),
                        rs.getString("delivery_session_id")
                ),
                cutoff.toEpochMilli()
        );
    }

    @Override
    public List<ImEvent> findAll() {
        return jdbcTemplate.query(FIND_ALL_SQL, rowMapper);
    }

    @Override
    public int requeueBySession(String clientId, String sessionId, String error) {
        Instant now = Instant.now();
        return jdbcTemplate.update(REQUEUE_BY_SESSION_SQL, error, now.toEpochMilli(), clientId, sessionId);
    }

    @Override
    public int sweepStaleLeases(Instant cutoff) {
        Instant now = Instant.now();
        int changed = jdbcTemplate.update(SWEEP_STALE_LEASES_SQL, now.toEpochMilli(), cutoff.toEpochMilli());
        if (changed > 0) {
            log.info("Swept stale leases: count={} cutoff={}", changed, cutoff);
        }
        return changed;
    }

    @Override
    @Transactional
    public long nextSequence() {
        jdbcTemplate.update(NEXT_SEQUENCE_SQL);
        Long next = jdbcTemplate.queryForObject(GET_SEQUENCE_SQL, Long.class);
        if (next != null) {
            sequenceCache.set(next);
            return next;
        }
        return sequenceCache.incrementAndGet();
    }

    @Override
    public ImEvent createUserMessage(
            String clientId,
            String conversationId,
            ConversationType conversationType,
            String senderId,
            String senderName,
            String text,
            List<MediaItem> media
    ) {
        long id = nextSequence();
        Instant now = Instant.now();
        ImEvent event = new ImEvent(
                id,
                "evt-" + UUID.randomUUID(),
                clientId,
                conversationId,
                conversationType == null ? ConversationType.direct : conversationType,
                senderId,
                senderName,
                text,
                media == null ? List.of() : media,
                EventStatus.pending,
                null,
                now,
                now,
                null,
                null,
                null,
                Map.of()
        );
        return insert(event);
    }

    @Override
    public ImEvent markProcessedFromReply(String eventId) {
        ImEvent existing = findByEventId(eventId);
        if (existing == null || existing.status() == EventStatus.processed) {
            return existing;
        }
        return updateStatus(eventId, EventStatus.processed, null);
    }

    private String toJson(Object obj) {
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (Exception e) {
            return null;
        }
    }

    private List<MediaItem> parseMedia(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<List<MediaItem>>() {});
        } catch (Exception e) {
            return List.of();
        }
    }

    private Map<String, Object> parseMetadata(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (Exception e) {
            return Map.of();
        }
    }
}
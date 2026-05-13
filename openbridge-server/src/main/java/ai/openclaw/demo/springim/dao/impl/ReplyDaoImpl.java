package ai.openclaw.demo.springim.dao.impl;

import ai.openclaw.demo.springim.dao.ReplyDao;
import ai.openclaw.demo.springim.model.ConversationType;
import ai.openclaw.demo.springim.model.MediaItem;
import ai.openclaw.demo.springim.model.OpenClawReply;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * JDBC implementation of ReplyDao using SQLite.
 */
@Repository
public class ReplyDaoImpl implements ReplyDao {

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    private static final String INSERT_SQL =
            "INSERT INTO replies (local_id, event_id, conversation_id, conversation_type, " +
            "text, media_json, reply_to_id, thread_id, created_at, received_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

    private static final String FIND_BY_LOCAL_ID_SQL = "SELECT * FROM replies WHERE local_id = ?";

    private static final String FIND_BY_CONVERSATION_ID_SQL = "SELECT * FROM replies WHERE conversation_id = ? ORDER BY created_at ASC";

    private static final String FIND_ALL_SQL = "SELECT * FROM replies ORDER BY created_at ASC";

    private final RowMapper<OpenClawReply> rowMapper = (rs, rowNum) -> {
        String localId = rs.getString("local_id");
        String eventId = rs.getString("event_id");
        String conversationId = rs.getString("conversation_id");
        ConversationType conversationType = ConversationType.valueOf(rs.getString("conversation_type"));
        String text = rs.getString("text") != null ? rs.getString("text") : "";
        List<MediaItem> media = parseMedia(rs.getString("media_json"));
        String replyToId = rs.getString("reply_to_id");
        String threadId = rs.getString("thread_id");
        Instant createdAt = Instant.ofEpochMilli(rs.getLong("created_at"));
        Instant receivedAt = Instant.ofEpochMilli(rs.getLong("received_at"));

        return new OpenClawReply(
                localId, eventId, conversationId, conversationType, text, media,
                replyToId, threadId, createdAt, receivedAt
        );
    };

    public ReplyDaoImpl(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    @Override
    public OpenClawReply insert(OpenClawReply reply) {
        jdbcTemplate.update(INSERT_SQL,
                reply.localId(),
                reply.eventId(),
                reply.conversationId(),
                reply.conversationType().name(),
                reply.text(),
                toJson(reply.media()),
                reply.replyToId(),
                reply.threadId(),
                reply.createdAt().toEpochMilli(),
                reply.receivedAt().toEpochMilli()
        );
        return reply;
    }

    @Override
    public OpenClawReply findByLocalId(String localId) {
        List<OpenClawReply> results = jdbcTemplate.query(FIND_BY_LOCAL_ID_SQL, rowMapper, localId);
        return results.isEmpty() ? null : results.get(0);
    }

    @Override
    public List<OpenClawReply> findByConversationId(String conversationId) {
        return jdbcTemplate.query(FIND_BY_CONVERSATION_ID_SQL, rowMapper, conversationId);
    }

    @Override
    public List<OpenClawReply> findAll() {
        return jdbcTemplate.query(FIND_ALL_SQL, rowMapper);
    }

    private String toJson(List<MediaItem> media) {
        try {
            return objectMapper.writeValueAsString(media);
        } catch (Exception e) {
            return "[]";
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
}
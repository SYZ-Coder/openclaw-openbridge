package ai.openclaw.demo.springim.service;

import ai.openclaw.demo.springim.dao.ReplyDao;
import ai.openclaw.demo.springim.model.ConversationType;
import ai.openclaw.demo.springim.model.MediaItem;
import ai.openclaw.demo.springim.model.OpenClawReply;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Reply store service using SQLite database.
 *
 * All persistence operations are delegated to ReplyDao.
 * This service provides the same interface as the original JSON-based implementation.
 */
@Service
public class ReplyStore {
    private static final Logger log = LoggerFactory.getLogger(ReplyStore.class);

    private final ReplyDao replyDao;

    public ReplyStore(ReplyDao replyDao) {
        this.replyDao = replyDao;
        log.info("ReplyStore initialized with SQLite DAO");
    }

    public OpenClawReply save(OpenClawReply reply) {
        // Check for duplicate
        OpenClawReply existing = replyDao.findByLocalId(reply.localId());
        if (existing != null) {
            log.info("Reply already exists, skipping: localId={}", reply.localId());
            return existing;
        }

        OpenClawReply saved = replyDao.insert(reply);
        log.info("Reply saved: localId={} eventId={} conversationId={}",
                saved.localId(), saved.eventId(), saved.conversationId());
        return saved;
    }

    public OpenClawReply create(
            String localId,
            String eventId,
            String conversationId,
            ConversationType conversationType,
            String text,
            List<MediaItem> media,
            String replyToId,
            String threadId,
            Instant createdAt
    ) {
        OpenClawReply reply = new OpenClawReply(
                localId,
                eventId,
                conversationId,
                conversationType == null ? ConversationType.direct : conversationType,
                text == null ? "" : text,
                media == null ? List.of() : media,
                replyToId,
                threadId,
                createdAt == null ? Instant.now() : createdAt,
                Instant.now()
        );
        return save(reply);
    }

    public List<OpenClawReply> findConversationReplies(String conversationId) {
        return replyDao.findByConversationId(conversationId);
    }

    public List<OpenClawReply> findAll() {
        return replyDao.findAll();
    }
}
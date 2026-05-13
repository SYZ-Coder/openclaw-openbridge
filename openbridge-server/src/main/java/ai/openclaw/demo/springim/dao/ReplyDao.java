package ai.openclaw.demo.springim.dao;

import ai.openclaw.demo.springim.model.OpenClawReply;
import java.util.List;

/**
 * Data Access Object for replies.
 *
 * Provides CRUD operations for the replies table.
 */
public interface ReplyDao {

    /**
     * Insert a new reply.
     */
    OpenClawReply insert(OpenClawReply reply);

    /**
     * Find reply by localId.
     */
    OpenClawReply findByLocalId(String localId);

    /**
     * Find all replies for a conversation.
     */
    List<OpenClawReply> findByConversationId(String conversationId);

    /**
     * Find all replies.
     */
    List<OpenClawReply> findAll();
}
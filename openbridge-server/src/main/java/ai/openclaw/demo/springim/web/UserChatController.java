package ai.openclaw.demo.springim.web;

import ai.openclaw.demo.springim.config.OpenClawBridgeProperties;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.ConversationView;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.EventView;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.ReplyView;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.UserMessageRequest;
import ai.openclaw.demo.springim.model.ImEvent;
import ai.openclaw.demo.springim.model.OpenClawReply;
import ai.openclaw.demo.springim.service.OpenClawBridgeService;
import ai.openclaw.demo.springim.support.LogSummaries;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 这组接口面向“模拟用户侧”的联调入口。
 */
@RestController
@RequestMapping("/api/im")
public class UserChatController {
    private static final Logger log = LoggerFactory.getLogger(UserChatController.class);
    private final OpenClawBridgeProperties properties;
    private final OpenClawBridgeService bridgeService;

    public UserChatController(OpenClawBridgeProperties properties, OpenClawBridgeService bridgeService) {
        this.properties = properties;
        this.bridgeService = bridgeService;
    }

    @PostMapping("/conversations/{conversationId}/messages")
    public ResponseEntity<EventView> sendUserMessage(
            @PathVariable String conversationId,
            @Valid @RequestBody UserMessageRequest request
    ) {
        String clientId = request.clientId() == null || request.clientId().isBlank()
                ? properties.getDefaultClientId()
                : request.clientId();
        log.info("user message request: {}", LogSummaries.summarizeUserMessage(conversationId, clientId, request));
        ImEvent event = bridgeService.createUserMessage(
                clientId,
                conversationId,
                request.conversationType(),
                request.senderId(),
                request.senderName(),
                request.text(),
                request.media()
        );
        log.info("user message accepted: {}", LogSummaries.summarizeEvent(event));
        return ResponseEntity.ok(toEventView(event));
    }

    @GetMapping("/conversations/{conversationId}")
    public ResponseEntity<ConversationView> conversation(@PathVariable String conversationId) {
        List<EventView> events = bridgeService.findConversationEvents(conversationId).stream()
                .map(UserChatController::toEventView)
                .toList();
        List<ReplyView> replies = bridgeService.findConversationReplies(conversationId).stream()
                .map(UserChatController::toReplyView)
                .toList();
        log.info("conversation fetch: conversationId={} userMessages={} openClawReplies={}", conversationId, events.size(), replies.size());
        return ResponseEntity.ok(new ConversationView(conversationId, events, replies));
    }

    @GetMapping("/events")
    public ResponseEntity<Map<String, Object>> events() {
        log.info("events fetch requested");
        return ResponseEntity.ok(Map.of(
                "events",
                bridgeService.findAllEvents().stream().map(UserChatController::toEventView).toList()
        ));
    }

    private static EventView toEventView(ImEvent event) {
        return new EventView(
                event.eventId(),
                event.clientId(),
                event.conversationId(),
                event.conversationType(),
                event.senderId(),
                event.senderName(),
                event.text(),
                event.media(),
                event.status().name(),
                event.lastError(),
                event.createdAt(),
                event.processedAt()
        );
    }

    private static ReplyView toReplyView(OpenClawReply reply) {
        return new ReplyView(
                reply.localId(),
                reply.eventId(),
                reply.conversationId(),
                reply.conversationType(),
                reply.text(),
                reply.media(),
                reply.createdAt(),
                reply.receivedAt()
        );
    }
}

package ai.openclaw.demo.springim.websocket;

import ai.openclaw.demo.springim.dto.DeviceDtos.ClientHelloV2;
import ai.openclaw.demo.springim.dto.OpenClawFrames.ClientAck;
import ai.openclaw.demo.springim.dto.OpenClawFrames.ClientReply;
import ai.openclaw.demo.springim.dto.OpenClawFrames.ServerReplyAck;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.ReplyRequest;
import ai.openclaw.demo.springim.security.OpenClawAuthService;
import ai.openclaw.demo.springim.service.ClientSessionRegistry;
import ai.openclaw.demo.springim.service.DeviceService;
import ai.openclaw.demo.springim.service.OpenClawBridgeService;
import ai.openclaw.demo.springim.support.LogSummaries;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

/**
 * 杩欐槸 OpenClaw 鎻掍欢涓?demo 鏈嶅姟涔嬮棿鐨?WebSocket 鍗忚鍏ュ彛銆? */
@Component
public class OpenClawWebSocketHandler extends TextWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(OpenClawWebSocketHandler.class);
    private final ObjectMapper objectMapper;
    private final OpenClawAuthService authService;
    private final OpenClawBridgeService bridgeService;
    private final ClientSessionRegistry sessions;
    private final DeviceService deviceService;

    public OpenClawWebSocketHandler(
            ObjectMapper objectMapper,
            OpenClawAuthService authService,
            OpenClawBridgeService bridgeService,
            ClientSessionRegistry sessions,
            DeviceService deviceService
    ) {
        this.objectMapper = objectMapper;
        this.authService = authService;
        this.bridgeService = bridgeService;
        this.sessions = sessions;
        this.deviceService = deviceService;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        Map<String, String> query = parseQuery(session.getUri());
        String clientId = query.get("clientId");
        String token = query.get("token");
        log.info("ws connected: sessionId={} uri={} clientId={}", session.getId(), session.getUri(), clientId);
        try {
            authService.verifyToken(clientId, token);
            session.getAttributes().put("verifiedClientId", clientId);
            log.info("ws token verified: sessionId={} clientId={}", session.getId(), clientId);
        } catch (RuntimeException e) {
            log.warn("ws token verification failed: sessionId={} clientId={} error={}", session.getId(), clientId, e.toString());
            closeQuietly(session, CloseStatus.POLICY_VIOLATION);
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        JsonNode root = objectMapper.readTree(message.getPayload());
        String type = root.path("type").asText();
        sessions.touch(session, type);
        log.info("ws frame received: sessionId={} type={} payload={}", session.getId(), type, summarizeInboundPayload(type, root));
        switch (type) {
            case "client.hello" -> handleHello(session, message.getPayload());
            case "client.ping" -> handlePing(session);
            case "client.ack" -> handleAck(session, message.getPayload());
            case "client.reply" -> handleReply(session, message.getPayload());
            default -> session.sendMessage(new TextMessage("{\"type\":\"server.resync-required\",\"reason\":\"unknown-frame\"}"));
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        log.info("ws closed: sessionId={} code={} reason={}", session.getId(), status.getCode(), status.getReason());
        Object verifiedClientId = session.getAttributes().get("verifiedClientId");
        if (verifiedClientId instanceof String clientId) {
            bridgeService.onSessionClosed(clientId, session.getId(), "websocket-closed");
        }
        sessions.unregister(session);
    }

    private void handleHello(WebSocketSession session, String payload) throws Exception {
        ClientHelloV2 hello = objectMapper.readValue(payload, ClientHelloV2.class);
        Object verifiedClientId = session.getAttributes().get("verifiedClientId");
        if (!(verifiedClientId instanceof String id) || !id.equals(hello.clientId())) {
            log.warn("ws hello rejected: sessionId={} reason=verified-client-mismatch helloClientId={} verifiedClientId={}", session.getId(), hello.clientId(), verifiedClientId);
            closeQuietly(session, CloseStatus.POLICY_VIOLATION);
            return;
        }
        if (hello.protocolVersion() < 2) {
            log.warn("ws hello rejected: sessionId={} reason=protocol-version protocolVersion={}", session.getId(), hello.protocolVersion());
            closeQuietly(session, CloseStatus.POLICY_VIOLATION);
            return;
        }
        if (!deviceService.verifyHello(hello)) {
            log.warn("ws hello rejected: sessionId={} reason=hello-verify-failed clientId={} deviceId={}", session.getId(), hello.clientId(), hello.deviceId());
            closeQuietly(session, CloseStatus.POLICY_VIOLATION);
            return;
        }
        session.getAttributes().put("deviceId", hello.deviceId());
        log.info(
                "ws hello accepted: sessionId={} clientId={} deviceId={} lastProcessedSequence={} lastProcessedEventId={}",
                session.getId(),
                hello.clientId(),
                hello.deviceId(),
                hello.lastProcessedSequence(),
                hello.lastProcessedEventId()
        );
        bridgeService.registerClient(hello.clientId(), session);
    }

    private void handlePing(WebSocketSession session) throws Exception {
        long now = System.currentTimeMillis();
        log.info("ws 心跳收到：sessionId={} ts={}", session.getId(), now);
        session.sendMessage(new TextMessage("{\"type\":\"server.pong\",\"ts\":" + now + "}"));
        log.info("ws 心跳响应已发送：sessionId={} ts={}", session.getId(), now);
    }

    private void handleAck(WebSocketSession session, String payload) throws Exception {
        ClientAck ack = objectMapper.readValue(payload, ClientAck.class);
        log.info("ws ack frame: eventId={} status={} error={}", ack.eventId(), ack.status(), ack.error());
        bridgeService.ack(ack.eventId(), ack.status(), ack.error(), session.getId());
    }

    private void handleReply(WebSocketSession session, String payload) throws Exception {
        ClientReply reply = objectMapper.readValue(payload, ClientReply.class);
        if (reply.reply() == null) {
            log.warn("ws reply frame skipped: missing reply payload");
            return;
        }
        ReplyRequest request = new ReplyRequest(
                reply.reply().localId(),
                reply.reply().eventId(),
                reply.reply().conversationId(),
                reply.reply().conversationType(),
                reply.reply().text(),
                reply.reply().media(),
                reply.reply().replyToId(),
                reply.reply().threadId(),
                reply.reply().createdAt()
        );
        log.info("ws reply frame: payload={}", LogSummaries.summarizeReplyRequest(request));
        ServerReplyAck ack;
        try {
            bridgeService.saveReply(request);
            ack = ServerReplyAck.saved(request.localId());
        } catch (RuntimeException e) {
            log.warn("ws reply persist failed: localId={} error={}", request.localId(), e.toString());
            ack = ServerReplyAck.failed(request.localId());
        }
        try {
            session.sendMessage(new TextMessage(objectMapper.writeValueAsString(ack)));
        } catch (Exception e) {
            log.warn("ws reply ack send failed: localId={} sessionId={} error={}", request.localId(), session.getId(), e.toString());
        }
    }

    private static Map<String, String> parseQuery(URI uri) {
        if (uri == null || uri.getRawQuery() == null || uri.getRawQuery().isBlank()) {
            return Map.of();
        }
        return Arrays.stream(uri.getRawQuery().split("&"))
                .map(part -> part.split("=", 2))
                .filter(parts -> parts.length == 2)
                .collect(Collectors.toMap(
                        parts -> decode(parts[0]),
                        parts -> decode(parts[1]),
                        (left, right) -> right
                ));
    }

    private static String decode(String value) {
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    private static void closeQuietly(WebSocketSession session, CloseStatus status) {
        try {
            session.close(status);
        } catch (Exception ignored) {
        }
    }

    private static Map<String, Object> summarizeInboundPayload(String type, JsonNode root) {
        return switch (type) {
            case "client.hello" -> Map.of(
                    "clientId", root.path("clientId").asText(""),
                    "deviceId", root.path("deviceId").asText(""),
                    "accountId", root.path("accountId").asText(""),
                    "protocolVersion", root.path("protocolVersion").asInt(0),
                    "lastProcessedSequence", root.path("lastProcessedSequence").asText("n/a"),
                    "lastProcessedEventId", root.path("lastProcessedEventId").asText("n/a")
            );
            case "client.ack" -> Map.of(
                    "eventId", root.path("eventId").asText(""),
                    "status", root.path("status").asText(""),
                    "error", root.path("error").asText("")
            );
            case "client.reply" -> Map.of(
                    "localId", root.path("reply").path("localId").asText(""),
                    "eventId", root.path("reply").path("eventId").asText(""),
                    "conversationId", root.path("reply").path("conversationId").asText(""),
                    "textPreview", preview(root.path("reply").path("text").asText("")),
                    "textLength", root.path("reply").path("text").asText("").length()
            );
            default -> Map.of("raw", preview(root.toString()));
        };
    }

    private static String preview(String text) {
        if (text == null) {
            return "";
        }
        String normalized = text.replaceAll("\\s+", " ").trim();
        if (normalized.length() <= 120) {
            return normalized;
        }
        return normalized.substring(0, 117) + "...";
    }
}

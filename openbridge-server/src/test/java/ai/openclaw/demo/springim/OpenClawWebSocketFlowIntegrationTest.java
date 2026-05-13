package ai.openclaw.demo.springim;

import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRegisterRequest;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRegisterResponse;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.ConversationView;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.EventView;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.ReplyView;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.UserMessageRequest;
import ai.openclaw.demo.springim.model.ConversationType;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OpenClawWebSocketFlowIntegrationTest {
    private static Path storageDir;

    @DynamicPropertySource
    static void registerProperties(DynamicPropertyRegistry registry) throws Exception {
        storageDir = Files.createTempDirectory("spring-im-demo-it-");
        registry.add("openclaw.bridge.storage-dir", () -> storageDir.toString());
    }

    @TempDir
    Path tempDir;

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate restTemplate;

    @Autowired
    ObjectMapper objectMapper;

    private WebSocketSession session;

    @AfterEach
    void closeSession() throws Exception {
        if (session != null && session.isOpen()) {
            session.close(CloseStatus.NORMAL);
        }
    }

    @Test
    void websocketFlowProcessesMessageEndToEnd() throws Exception {
        KeyPair keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String deviceId = "dev-" + UUID.randomUUID();
        String installId = "inst-" + UUID.randomUUID();
        String clientId = "test-client-01";
        String token = "test-token-123";
        String accountId = "default";
        String conversationId = "conv-it-" + UUID.randomUUID();

        DeviceRegisterResponse registerResponse = registerDevice(clientId, token, deviceId, installId, keyPair);
        assertEquals(clientId, registerResponse.clientId());
        assertEquals(deviceId, registerResponse.deviceId());

        BlockingQueue<JsonNode> frames = new LinkedBlockingQueue<>();
        CompletableFuture<WebSocketSession> connected = new CompletableFuture<>();
        StandardWebSocketClient webSocketClient = new StandardWebSocketClient();
        TestHandler handler = new TestHandler(objectMapper, frames, connected);
        URI uri = URI.create("ws://127.0.0.1:" + port + "/api/openclaw/ws?clientId=" + clientId + "&accountId=" + accountId + "&token=" + token);
        webSocketClient.execute(handler, new WebSocketHttpHeaders(), uri);
        session = connected.get(10, TimeUnit.SECONDS);

        long helloTimestamp = System.currentTimeMillis();
        String helloNonce = UUID.randomUUID().toString();
        String helloSignature = signHello(keyPair, deviceId, clientId, accountId, helloTimestamp, helloNonce);
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.hello",
                "protocolVersion", 2,
                "deviceId", deviceId,
                "clientId", clientId,
                "accountId", accountId,
                "timestamp", helloTimestamp,
                "nonce", helloNonce,
                "signature", helloSignature
        ))));

        JsonNode helloFrame = pollFrame(frames, "server.hello", Duration.ofSeconds(10));
        assertNotNull(helloFrame);

        UserMessageRequest request = new UserMessageRequest(
                clientId,
                ConversationType.direct,
                "browser-user-001",
                "Browser Tester",
                "integration ping",
                List.of()
        );
        ResponseEntity<EventView> created = restTemplate.postForEntity(
                "http://127.0.0.1:" + port + "/api/im/conversations/" + conversationId + "/messages",
                request,
                EventView.class
        );
        assertEquals(200, created.getStatusCode().value());
        String eventId = created.getBody().eventId();

        JsonNode messageFrame = pollFrame(frames, "message", Duration.ofSeconds(10));
        assertNotNull(messageFrame);
        assertEquals(eventId, messageFrame.path("eventId").asText());

        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.ack",
                "eventId", eventId,
                "status", "received",
                "error", ""
        ))));

        String localId = "reply-" + UUID.randomUUID();
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.reply",
                "reply", Map.of(
                        "localId", localId,
                        "eventId", eventId,
                        "conversationId", conversationId,
                        "conversationType", "direct",
                        "text", "integration pong",
                        "media", List.of(),
                        "createdAt", System.currentTimeMillis()
                )
        ))));

        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.ack",
                "eventId", eventId,
                "status", "processed",
                "error", ""
        ))));

        ConversationView conversation = awaitConversationProcessed(conversationId, eventId, localId, Duration.ofSeconds(10));
        assertNotNull(conversation);
        assertEquals(1, conversation.openClawReplies().size());
        assertEquals("processed", findEvent(conversation, eventId).status());
        assertEquals(localId, conversation.openClawReplies().get(0).localId());
    }

    @Test
    void websocketFlowProcessesConsecutiveMessagesWithoutReconnect() throws Exception {
        KeyPair keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String deviceId = "dev-" + UUID.randomUUID();
        String installId = "inst-" + UUID.randomUUID();
        String clientId = "test-client-01";
        String token = "test-token-123";
        String accountId = "default";
        String conversationId = "conv-it-seq-" + UUID.randomUUID();

        DeviceRegisterResponse registerResponse = registerDevice(clientId, token, deviceId, installId, keyPair);
        assertEquals(clientId, registerResponse.clientId());

        BlockingQueue<JsonNode> frames = new LinkedBlockingQueue<>();
        CompletableFuture<WebSocketSession> connected = new CompletableFuture<>();
        StandardWebSocketClient webSocketClient = new StandardWebSocketClient();
        TestHandler handler = new TestHandler(objectMapper, frames, connected);
        URI uri = URI.create("ws://127.0.0.1:" + port + "/api/openclaw/ws?clientId=" + clientId + "&accountId=" + accountId + "&token=" + token);
        webSocketClient.execute(handler, new WebSocketHttpHeaders(), uri);
        session = connected.get(10, TimeUnit.SECONDS);

        long helloTimestamp = System.currentTimeMillis();
        String helloNonce = UUID.randomUUID().toString();
        String helloSignature = signHello(keyPair, deviceId, clientId, accountId, helloTimestamp, helloNonce);
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.hello",
                "protocolVersion", 2,
                "deviceId", deviceId,
                "clientId", clientId,
                "accountId", accountId,
                "timestamp", helloTimestamp,
                "nonce", helloNonce,
                "signature", helloSignature
        ))));

        JsonNode helloFrame = pollFrame(frames, "server.hello", Duration.ofSeconds(10));
        assertNotNull(helloFrame);

        String firstEventId = createMessage(conversationId, clientId, "first online ping");
        JsonNode firstMessageFrame = pollFrame(frames, "message", Duration.ofSeconds(10));
        assertNotNull(firstMessageFrame);
        assertEquals(firstEventId, firstMessageFrame.path("eventId").asText());
        completeMessage(session, conversationId, firstEventId, "first online pong");
        awaitConversationProcessed(conversationId, firstEventId, null, Duration.ofSeconds(10));

        String secondEventId = createMessage(conversationId, clientId, "second online ping");
        JsonNode secondMessageFrame = pollFrame(frames, "message", Duration.ofSeconds(10));
        assertNotNull(secondMessageFrame);
        assertEquals(secondEventId, secondMessageFrame.path("eventId").asText());
        completeMessage(session, conversationId, secondEventId, "second online pong");
        ConversationView conversation = awaitConversationProcessed(conversationId, secondEventId, null, Duration.ofSeconds(10));
        assertEquals("processed", findEvent(conversation, firstEventId).status());
        assertEquals("processed", findEvent(conversation, secondEventId).status());
    }

    @Test
    void reconnectDoesNotReplayProcessedHistoryButReplaysUnfinishedMessage() throws Exception {
        KeyPair keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String deviceId = "dev-" + UUID.randomUUID();
        String installId = "inst-" + UUID.randomUUID();
        String clientId = "test-client-01";
        String token = "test-token-123";
        String accountId = "default";
        String conversationId = "conv-it-reconnect-" + UUID.randomUUID();

        registerDevice(clientId, token, deviceId, installId, keyPair);

        BlockingQueue<JsonNode> frames = new LinkedBlockingQueue<>();
        session = connectClient(frames, clientId, accountId, token, deviceId, keyPair);

        String processedEventId = createMessage(conversationId, clientId, "processed before reconnect");
        JsonNode processedMessageFrame = pollFrame(frames, "message", Duration.ofSeconds(10));
        assertNotNull(processedMessageFrame);
        assertEquals(processedEventId, processedMessageFrame.path("eventId").asText());
        completeMessage(session, conversationId, processedEventId, "processed reply");
        awaitConversationProcessed(conversationId, processedEventId, null, Duration.ofSeconds(10));

        session.close(CloseStatus.NORMAL);
        session = connectClient(frames, clientId, accountId, token, deviceId, keyPair);
        JsonNode replayedProcessed = pollFrame(frames, "message", Duration.ofSeconds(1));
        assertTrue(replayedProcessed == null, "processed history should not replay after reconnect");

        String unfinishedEventId = createMessage(conversationId, clientId, "unfinished before reconnect");
        JsonNode unfinishedMessageFrame = pollFrame(frames, "message", Duration.ofSeconds(10));
        assertNotNull(unfinishedMessageFrame);
        assertEquals(unfinishedEventId, unfinishedMessageFrame.path("eventId").asText());
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.ack",
                "eventId", unfinishedEventId,
                "status", "received",
                "error", ""
        ))));

        session.close(CloseStatus.NORMAL);
        session = connectClient(frames, clientId, accountId, token, deviceId, keyPair);
        JsonNode replayedUnfinished = pollFrame(frames, "message", Duration.ofSeconds(10));
        assertNotNull(replayedUnfinished);
        assertEquals(unfinishedEventId, replayedUnfinished.path("eventId").asText());

        completeMessage(session, conversationId, unfinishedEventId, "unfinished reply");
        ConversationView conversation = awaitConversationProcessed(conversationId, unfinishedEventId, null, Duration.ofSeconds(10));
        assertEquals("processed", findEvent(conversation, processedEventId).status());
        assertEquals("processed", findEvent(conversation, unfinishedEventId).status());
    }

    @Test
    void staleDeliveryLeaseClosesZombieSessionAndReplaysAfterReconnect() throws Exception {
        KeyPair keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        String deviceId = "dev-" + UUID.randomUUID();
        String installId = "inst-" + UUID.randomUUID();
        String clientId = "test-client-01";
        String token = "test-token-123";
        String accountId = "default";
        String conversationId = "conv-it-stale-" + UUID.randomUUID();

        registerDevice(clientId, token, deviceId, installId, keyPair);

        BlockingQueue<JsonNode> frames = new LinkedBlockingQueue<>();
        session = connectClient(frames, clientId, accountId, token, deviceId, keyPair);

        String eventId = createMessage(conversationId, clientId, "stale lease ping");
        JsonNode firstDelivery = pollFrame(frames, "message", Duration.ofSeconds(10));
        assertNotNull(firstDelivery);
        assertEquals(eventId, firstDelivery.path("eventId").asText());

        awaitSessionClosed(session, Duration.ofSeconds(25));
        session = connectClient(frames, clientId, accountId, token, deviceId, keyPair);

        JsonNode replayed = pollFrame(frames, "message", Duration.ofSeconds(10));
        assertNotNull(replayed);
        assertEquals(eventId, replayed.path("eventId").asText());

        completeMessage(session, conversationId, eventId, "stale lease recovered");
        ConversationView conversation = awaitConversationProcessed(conversationId, eventId, null, Duration.ofSeconds(10));
        assertEquals("processed", findEvent(conversation, eventId).status());
    }

    private WebSocketSession connectClient(
            BlockingQueue<JsonNode> frames,
            String clientId,
            String accountId,
            String token,
            String deviceId,
            KeyPair keyPair
    ) throws Exception {
        CompletableFuture<WebSocketSession> connected = new CompletableFuture<>();
        StandardWebSocketClient webSocketClient = new StandardWebSocketClient();
        TestHandler handler = new TestHandler(objectMapper, frames, connected);
        URI uri = URI.create("ws://127.0.0.1:" + port + "/api/openclaw/ws?clientId=" + clientId + "&accountId=" + accountId + "&token=" + token);
        webSocketClient.execute(handler, new WebSocketHttpHeaders(), uri);
        WebSocketSession connectedSession = connected.get(10, TimeUnit.SECONDS);

        long helloTimestamp = System.currentTimeMillis();
        String helloNonce = UUID.randomUUID().toString();
        String helloSignature = signHello(keyPair, deviceId, clientId, accountId, helloTimestamp, helloNonce);
        connectedSession.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.hello",
                "protocolVersion", 2,
                "deviceId", deviceId,
                "clientId", clientId,
                "accountId", accountId,
                "timestamp", helloTimestamp,
                "nonce", helloNonce,
                "signature", helloSignature
        ))));

        JsonNode helloFrame = pollFrame(frames, "server.hello", Duration.ofSeconds(10));
        assertNotNull(helloFrame);
        return connectedSession;
    }

    private DeviceRegisterResponse registerDevice(String clientId, String token, String deviceId, String installId, KeyPair keyPair) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.set("x-openclaw-client-id", clientId);
        headers.setContentType(MediaType.APPLICATION_JSON);
        DeviceRegisterRequest request = new DeviceRegisterRequest(
                deviceId,
                installId,
                "Integration Device",
                toPem(keyPair),
                "fingerprint-" + deviceId,
                null
        );
        return restTemplate.exchange(
                "http://127.0.0.1:" + port + "/api/openclaw/devices/register",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                DeviceRegisterResponse.class
        ).getBody();
    }

    private String createMessage(String conversationId, String clientId, String text) {
        UserMessageRequest request = new UserMessageRequest(
                clientId,
                ConversationType.direct,
                "browser-user-001",
                "Browser Tester",
                text,
                List.of()
        );
        ResponseEntity<EventView> created = restTemplate.postForEntity(
                "http://127.0.0.1:" + port + "/api/im/conversations/" + conversationId + "/messages",
                request,
                EventView.class
        );
        assertEquals(200, created.getStatusCode().value());
        return created.getBody().eventId();
    }

    private void completeMessage(WebSocketSession session, String conversationId, String eventId, String replyText) throws Exception {
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.ack",
                "eventId", eventId,
                "status", "received",
                "error", ""
        ))));
        String localId = "reply-" + UUID.randomUUID();
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.reply",
                "reply", Map.of(
                        "localId", localId,
                        "eventId", eventId,
                        "conversationId", conversationId,
                        "conversationType", "direct",
                        "text", replyText,
                        "media", List.of(),
                        "createdAt", System.currentTimeMillis()
                )
        ))));
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(Map.of(
                "type", "client.ack",
                "eventId", eventId,
                "status", "processed",
                "error", ""
        ))));
    }

    private ConversationView awaitConversationProcessed(String conversationId, String eventId, String localId, Duration timeout) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            ResponseEntity<ConversationView> response = restTemplate.getForEntity(
                    "http://127.0.0.1:" + port + "/api/im/conversations/" + conversationId,
                    ConversationView.class
            );
            ConversationView view = response.getBody();
            if (view != null) {
                EventView event = findEvent(view, eventId);
                boolean replyPresent = localId == null
                        ? !view.openClawReplies().isEmpty()
                        : view.openClawReplies().stream().map(ReplyView::localId).anyMatch(localId::equals);
                if (event != null && "processed".equals(event.status()) && replyPresent) {
                    return view;
                }
            }
            Thread.sleep(100);
        }
        throw new AssertionError("conversation did not reach processed state in time");
    }

    private EventView findEvent(ConversationView conversation, String eventId) {
        return conversation.userMessages().stream()
                .filter(event -> eventId.equals(event.eventId()))
                .findFirst()
                .orElse(null);
    }

    private JsonNode pollFrame(BlockingQueue<JsonNode> frames, String expectedType, Duration timeout) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            JsonNode frame = frames.poll(200, TimeUnit.MILLISECONDS);
            if (frame != null && expectedType.equals(frame.path("type").asText())) {
                return frame;
            }
        }
        return null;
    }

    private void awaitSessionClosed(WebSocketSession targetSession, Duration timeout) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (!targetSession.isOpen()) {
                return;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("session was not closed after stale delivery lease");
    }

    private String signHello(KeyPair keyPair, String deviceId, String clientId, String accountId, long timestamp, String nonce) throws Exception {
        String payload = String.join(".", deviceId, clientId, accountId, String.valueOf(timestamp), nonce);
        Signature signature = Signature.getInstance("Ed25519");
        signature.initSign(keyPair.getPrivate());
        signature.update(payload.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(signature.sign());
    }

    private String toPem(KeyPair keyPair) {
        String encoded = Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.UTF_8))
                .encodeToString(keyPair.getPublic().getEncoded());
        return "-----BEGIN PUBLIC KEY-----\n" + encoded + "\n-----END PUBLIC KEY-----";
    }

    private static final class TestHandler extends TextWebSocketHandler {
        private final ObjectMapper objectMapper;
        private final BlockingQueue<JsonNode> frames;
        private final CompletableFuture<WebSocketSession> connected;

        private TestHandler(ObjectMapper objectMapper, BlockingQueue<JsonNode> frames, CompletableFuture<WebSocketSession> connected) {
            this.objectMapper = objectMapper;
            this.frames = frames;
            this.connected = connected;
        }

        @Override
        public void afterConnectionEstablished(WebSocketSession session) {
            connected.complete(session);
        }

        @Override
        protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
            frames.offer(objectMapper.readTree(message.getPayload()));
        }
    }
}

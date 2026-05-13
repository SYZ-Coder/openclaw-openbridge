package ai.openclaw.demo.springim.service;

import ai.openclaw.demo.springim.dto.OpenClawFrames.ServerBye;
import ai.openclaw.demo.springim.dto.OpenClawFrames.ServerMessage;
import ai.openclaw.demo.springim.model.ImEvent;
import ai.openclaw.demo.springim.support.LogSummaries;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

@Service
public class ClientSessionRegistry implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(ClientSessionRegistry.class);
    private static final int SEND_TIME_LIMIT_MS = 5_000;
    private static final int SEND_BUFFER_SIZE_BYTES = 512 * 1024;
    private static final long SHUTDOWN_BROADCAST_BUDGET_MS = 4_000;
    private static final int SHUTDOWN_LIFECYCLE_PHASE = Integer.MAX_VALUE - 100;

    private final ObjectMapper objectMapper;
    private final SessionBindingService sessionBindingService;
    private final Map<String, SessionBinding> sessions = new ConcurrentHashMap<>();
    private final ExecutorService sendExecutor = Executors.newCachedThreadPool(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "openclaw-ws-send");
            thread.setDaemon(true);
            return thread;
        }
    });
    private volatile boolean lifecycleRunning = false;

    public ClientSessionRegistry(ObjectMapper objectMapper, SessionBindingService sessionBindingService) {
        this.objectMapper = objectMapper;
        this.sessionBindingService = sessionBindingService;
    }

    public void register(String clientId, WebSocketSession session) {
        WebSocketSession managedSession = decorate(session);
        sessions.put(clientId, new SessionBinding(managedSession, session.getId(), new ConcurrentHashMap<>(), new AtomicLong(System.currentTimeMillis())));
        session.getAttributes().put("clientId", clientId);
        sessionBindingService.bindSession(clientId, session.getId());
        log.info("OpenClaw 会话已注册：clientId={} sessionId={} instanceId={} open={}",
                clientId, session.getId(), sessionBindingService.getInstanceId(), session.isOpen());
    }

    public void unregister(WebSocketSession session) {
        Object clientId = session.getAttributes().get("clientId");
        if (clientId instanceof String id) {
            sessions.computeIfPresent(id, (ignored, binding) -> binding.rawSessionId().equals(session.getId()) ? null : binding);
            sessionBindingService.unbindSession(id);
            log.info("OpenClaw 会话已注销：clientId={} sessionId={}", id, session.getId());
        }
    }

    public boolean hasOpenSession(String clientId) {
        SessionBinding binding = sessions.get(clientId);
        return binding != null && binding.session().isOpen();
    }

    public void touch(WebSocketSession session, String reason) {
        Object clientId = session.getAttributes().get("clientId");
        if (!(clientId instanceof String id)) {
            return;
        }
        SessionBinding binding = sessions.get(id);
        if (binding == null || !binding.rawSessionId().equals(session.getId())) {
            return;
        }
        long now = System.currentTimeMillis();
        binding.lastSeenEpochMs().set(now);
        sessionBindingService.touchSession(id);
        log.info("OpenClaw 会话心跳刷新：clientId={} sessionId={} reason={} lastSeenAt={} instanceId={}",
                id, session.getId(), reason, now, sessionBindingService.getInstanceId());
    }

    public Map<String, String> closeStaleSessions(long cutoffEpochMs, String reason) {
        Map<String, String> closed = new HashMap<>();
        sessions.forEach((clientId, binding) -> {
            if (!binding.session().isOpen()) {
                return;
            }
            long lastSeen = binding.lastSeenEpochMs().get();
            if (lastSeen >= cutoffEpochMs) {
                return;
            }
            if (sessions.remove(clientId, binding)) {
                closed.put(clientId, binding.rawSessionId());
                log.warn(
                        "OpenClaw 会话心跳超时关闭：clientId={} sessionId={} lastSeenAt={} cutoff={} reason={}",
                        clientId,
                        binding.rawSessionId(),
                        lastSeen,
                        cutoffEpochMs,
                        reason
                );
                closeQuietly(binding.session(), CloseStatus.SESSION_NOT_RELIABLE);
            }
        });
        return closed;
    }

    public String currentSessionId(String clientId) {
        SessionBinding binding = sessions.get(clientId);
        return binding == null ? null : binding.session().getId();
    }

    public boolean pushEvent(ImEvent event) {
        SessionBinding binding = sessions.get(event.clientId());
        WebSocketSession session = binding == null ? null : binding.session();
        if (session == null || !session.isOpen()) {
            log.warn(
                    "消息推送跳过：clientId={} sessionPresent={} sessionOpen={} eventId={} conversationId={}",
                    event.clientId(),
                    session != null,
                    session != null && session.isOpen(),
                    event.eventId(),
                    event.conversationId()
            );
            return false;
        }
        try {
            sendText(session, objectMapper.writeValueAsString(toServerMessage(event)));
            binding.inFlightEvents().put(event.eventId(), new InFlightEvent(System.currentTimeMillis()));
            log.info("消息推送成功：clientId={} sessionId={} event={}", event.clientId(), session.getId(), LogSummaries.summarizeEvent(event));
            return true;
        } catch (IOException e) {
            sessions.remove(event.clientId(), binding);
            log.error(
                    "消息推送失败：clientId={} sessionId={} eventId={} conversationId={}",
                    event.clientId(),
                    session.getId(),
                    event.eventId(),
                    event.conversationId(),
                    e
            );
            return false;
        }
    }

    public void send(String clientId, Object frame) throws IOException {
        SessionBinding binding = sessions.get(clientId);
        WebSocketSession session = binding == null ? null : binding.session();
        if (session != null && session.isOpen()) {
            try {
                sendText(session, objectMapper.writeValueAsString(frame));
                log.info("控制帧发送成功：clientId={} sessionId={} frameType={}", clientId, session.getId(), frame.getClass().getSimpleName());
            } catch (IOException e) {
                sessions.remove(clientId, binding);
                throw e;
            }
        } else {
            log.warn("控制帧发送跳过：clientId={} sessionPresent={} sessionOpen={}", clientId, session != null, session != null && session.isOpen());
        }
    }

    public boolean isInFlight(String clientId, String eventId) {
        SessionBinding binding = sessions.get(clientId);
        return binding != null && binding.inFlightEvents().containsKey(eventId);
    }

    public Map<String, String> inFlightSnapshot(String clientId) {
        SessionBinding binding = sessions.get(clientId);
        if (binding == null) {
            return Map.of();
        }
        Map<String, String> snapshot = new HashMap<>();
        binding.inFlightEvents().forEach((eventId, event) -> snapshot.put(eventId, String.valueOf(event.sentAtEpochMs())));
        return snapshot;
    }

    public int expireInFlightOlderThan(String clientId, long cutoffEpochMs) {
        SessionBinding binding = sessions.get(clientId);
        if (binding == null) {
            return 0;
        }
        int before = binding.inFlightEvents().size();
        binding.inFlightEvents().entrySet().removeIf(entry -> entry.getValue().sentAtEpochMs() < cutoffEpochMs);
        int expired = before - binding.inFlightEvents().size();
        if (expired > 0) {
            log.warn(
                    "飞行中消息租约已过期：clientId={} sessionId={} expiredCount={} cutoffEpochMs={}",
                    clientId,
                    binding.session().getId(),
                    expired,
                    cutoffEpochMs
            );
        }
        return expired;
    }

    public void clearInFlight(String clientId, String eventId) {
        SessionBinding binding = sessions.get(clientId);
        if (binding == null) {
            return;
        }
        InFlightEvent removed = binding.inFlightEvents().remove(eventId);
        if (removed != null) {
            log.info("飞行中消息已清除：clientId={} sessionId={} eventId={} sentAt={}", clientId, binding.session().getId(), eventId, removed.sentAtEpochMs());
        }
    }

    public void closeSession(String clientId, String reason) {
        SessionBinding binding = sessions.remove(clientId);
        if (binding == null) {
            return;
        }
        log.warn("会话已主动关闭: clientId={} sessionId={} reason={}", clientId, binding.session().getId(), reason);
        closeQuietly(binding.session(), CloseStatus.SESSION_NOT_RELIABLE);
    }

    public Iterable<String> openClientIds() {
        return sessions.entrySet().stream()
                .filter(entry -> entry.getValue().session().isOpen())
                .map(Map.Entry::getKey)
                .toList();
    }

    private static ServerMessage toServerMessage(ImEvent event) {
        return new ServerMessage(
                "message",
                event.eventId(),
                event.id(),
                event.conversationId(),
                event.conversationType(),
                event.senderId(),
                event.senderName(),
                event.text(),
                event.media(),
                event.createdAt().toEpochMilli(),
                null,
                null,
                event.metadata()
        );
    }

    private static WebSocketSession decorate(WebSocketSession session) {
        if (session instanceof ConcurrentWebSocketSessionDecorator) {
            return session;
        }
        return new ConcurrentWebSocketSessionDecorator(session, SEND_TIME_LIMIT_MS, SEND_BUFFER_SIZE_BYTES);
    }

    private void sendText(WebSocketSession session, String payload) throws IOException {
        Future<?> future = sendExecutor.submit(() -> {
            try {
                session.sendMessage(new TextMessage(payload));
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });
        try {
            future.get(SEND_TIME_LIMIT_MS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            closeQuietly(session, CloseStatus.SESSION_NOT_RELIABLE);
            throw new IOException("WebSocket 发送超时，超过 " + SEND_TIME_LIMIT_MS + "ms", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("WebSocket 发送被中断", e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException runtime && runtime.getCause() instanceof IOException io) {
                throw io;
            }
            throw new IOException("WebSocket 发送失败", cause);
        }
    }

    private static void closeQuietly(WebSocketSession session, CloseStatus status) {
        try {
            session.close(status);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void start() {
        lifecycleRunning = true;
    }

    @Override
    public void stop() {
        stop(() -> {});
    }

    @Override
    public void stop(Runnable callback) {
        try {
            broadcastBye();
        } finally {
            sendExecutor.shutdownNow();
            lifecycleRunning = false;
            callback.run();
        }
    }

    @Override
    public boolean isRunning() {
        return lifecycleRunning;
    }

    @Override
    public boolean isAutoStartup() {
        return true;
    }

    @Override
    public int getPhase() {
        return SHUTDOWN_LIFECYCLE_PHASE;
    }

    private void broadcastBye() {
        List<Map.Entry<String, SessionBinding>> snapshot = new ArrayList<>(sessions.entrySet());
        if (snapshot.isEmpty()) {
            return;
        }
        String byeFrame;
        try {
            byeFrame = objectMapper.writeValueAsString(ServerBye.shutdown());
        } catch (IOException e) {
            log.warn("server.bye 序列化失败，跳过广播: error={}", e.toString());
            return;
        }
        log.info("server.bye 广播开始: sessionCount={} budgetMs={}", snapshot.size(), SHUTDOWN_BROADCAST_BUDGET_MS);
        CountDownLatch latch = new CountDownLatch(snapshot.size());
        for (Map.Entry<String, SessionBinding> entry : snapshot) {
            String clientId = entry.getKey();
            WebSocketSession session = entry.getValue().session();
            try {
                sendExecutor.submit(() -> {
                    try {
                        if (session.isOpen()) {
                            session.sendMessage(new TextMessage(byeFrame));
                        }
                    } catch (Exception ex) {
                        log.warn("server.bye 发送失败: clientId={} sessionId={} error={}", clientId, session.getId(), ex.toString());
                    } finally {
                        closeQuietly(session, CloseStatus.GOING_AWAY);
                        latch.countDown();
                    }
                });
            } catch (RuntimeException ex) {
                log.warn("server.bye 提交失败: clientId={} error={}", clientId, ex.toString());
                closeQuietly(session, CloseStatus.GOING_AWAY);
                latch.countDown();
            }
        }
        try {
            boolean drained = latch.await(SHUTDOWN_BROADCAST_BUDGET_MS, TimeUnit.MILLISECONDS);
            log.info("server.bye 广播结束: drained={} pending={}", drained, latch.getCount());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("server.bye 广播被中断: pending={}", latch.getCount());
        }
    }

    private record SessionBinding(
            WebSocketSession session,
            String rawSessionId,
            Map<String, InFlightEvent> inFlightEvents,
            AtomicLong lastSeenEpochMs
    ) {
    }

    private record InFlightEvent(long sentAtEpochMs) {
    }
}

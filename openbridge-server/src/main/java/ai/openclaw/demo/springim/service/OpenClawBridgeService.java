package ai.openclaw.demo.springim.service;

import ai.openclaw.demo.springim.config.OpenClawBridgeProperties;
import ai.openclaw.demo.springim.dto.OpenClawFrames.ServerHello;
import ai.openclaw.demo.springim.dto.OpenClawRestDtos.ReplyRequest;
import ai.openclaw.demo.springim.model.ConversationType;
import ai.openclaw.demo.springim.model.ImEvent;
import ai.openclaw.demo.springim.model.MediaItem;
import ai.openclaw.demo.springim.model.OpenClawReply;
import ai.openclaw.demo.springim.support.LogSummaries;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.WebSocketSession;

@Service
public class OpenClawBridgeService {
    private static final Logger log = LoggerFactory.getLogger(OpenClawBridgeService.class);
    private static final long IN_FLIGHT_LEASE_MS = 15_000L;
    private static final long SESSION_IDLE_TIMEOUT_MS = 35_000L;

    private final OpenClawBridgeProperties properties;
    private final ImEventStore eventStore;
    private final ReplyStore replyStore;
    private final ClientSessionRegistry sessions;
    private final Map<String, DeliveryState> deliveryStates = new ConcurrentHashMap<>();
    private final ExecutorService deliveryExecutor = Executors.newCachedThreadPool(namedThread("openclaw-delivery"));
    private final ScheduledExecutorService deliveryRetryExecutor = Executors.newSingleThreadScheduledExecutor(namedThread("openclaw-delivery-retry"));
    private final ScheduledExecutorService deliverySweepExecutor = Executors.newSingleThreadScheduledExecutor(namedThread("openclaw-delivery-sweep"));

    public OpenClawBridgeService(
            OpenClawBridgeProperties properties,
            ImEventStore eventStore,
            ReplyStore replyStore,
            ClientSessionRegistry sessions
    ) {
        this.properties = properties;
        this.eventStore = eventStore;
        this.replyStore = replyStore;
        this.sessions = sessions;
        this.deliverySweepExecutor.scheduleWithFixedDelay(this::sweepOpenSessions, 2, 2, TimeUnit.SECONDS);
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
        String targetClientId = clientId == null || clientId.isBlank()
                ? properties.getDefaultClientId()
                : clientId;
        ImEvent event = eventStore.createUserMessage(
                targetClientId,
                conversationId,
                conversationType,
                senderId,
                senderName,
                text,
                media
        );
        boolean sessionOpen = sessions.hasOpenSession(targetClientId);
        Map<String, String> inFlight = sessions.inFlightSnapshot(targetClientId);
        log.info(
                "用户消息已创建: clientId={} sessionOpen={} inFlightCount={} event={}",
                targetClientId,
                sessionOpen,
                inFlight.size(),
                LogSummaries.summarizeEvent(event)
        );
        requestDelivery(targetClientId, "create");
        scheduleDeliveryRetry(targetClientId, "create");
        return event;
    }

    public void registerClient(String clientId, WebSocketSession session) throws IOException {
        sessions.register(clientId, session);
        sessions.send(clientId, ServerHello.of());
        log.info("OpenClaw 客户端已注册: clientId={} sessionId={}", clientId, session.getId());
        requestDelivery(clientId, "register");
        scheduleDeliveryRetry(clientId, "register");
    }

    public void ack(String eventId, String status, String error, String sessionId) {
        ImEvent updated = eventStore.markAck(eventId, status, error, sessionId);
        log.info("确认状态已落盘: eventId={} status={} error={}", eventId, status, error);
        if (updated == null) {
            return;
        }
        if ("processed".equals(status) || "failed".equals(status) || "duplicate".equals(status)) {
            sessions.clearInFlight(updated.clientId(), eventId);
        }
        requestDelivery(updated.clientId(), "ack:" + status);
        scheduleDeliveryRetry(updated.clientId(), "ack:" + status);
    }

    public void onSessionClosed(String clientId, String sessionId, String reason) {
        if (clientId == null || clientId.isBlank() || sessionId == null || sessionId.isBlank()) {
            return;
        }
        int requeued = eventStore.requeueSessionEvents(clientId, sessionId, reason);
        log.info("会话关闭后消息已回队: clientId={} sessionId={} reason={} requeued={}", clientId, sessionId, reason, requeued);
        requestDelivery(clientId, "session-closed");
    }

    public OpenClawReply saveReply(ReplyRequest request) {
        OpenClawReply reply = new OpenClawReply(
                request.localId(),
                request.eventId(),
                request.conversationId(),
                request.conversationType() == null ? ConversationType.direct : request.conversationType(),
                request.text() == null ? "" : request.text(),
                request.media() == null ? List.of() : request.media(),
                request.replyToId(),
                request.threadId(),
                request.createdAt() == null ? Instant.now() : Instant.ofEpochMilli(request.createdAt()),
                Instant.now()
        );
        OpenClawReply saved = replyStore.save(reply);
        ImEvent updatedEvent = null;
        if (request.eventId() != null && !request.eventId().isBlank()) {
            updatedEvent = eventStore.markProcessedFromReply(request.eventId());
        }
        log.info("回复已落盘: {}", LogSummaries.summarizeReply(saved));
        if (updatedEvent != null) {
            sessions.clearInFlight(updatedEvent.clientId(), updatedEvent.eventId());
            requestDelivery(updatedEvent.clientId(), "reply-persisted");
            scheduleDeliveryRetry(updatedEvent.clientId(), "reply-persisted");
            log.info(
                    "事件已根据回复推进: eventId={} clientId={} status={}",
                    updatedEvent.eventId(),
                    updatedEvent.clientId(),
                    updatedEvent.status()
            );
        }
        return saved;
    }

    public List<ImEvent> findConversationEvents(String conversationId) {
        return eventStore.findConversationEvents(conversationId);
    }

    public List<OpenClawReply> findConversationReplies(String conversationId) {
        return replyStore.findConversationReplies(conversationId);
    }

    public List<ImEvent> findAllEvents() {
        return eventStore.findAll();
    }

    private void requestDelivery(String clientId, String reason) {
        DeliveryState state = deliveryStates.computeIfAbsent(clientId, ignored -> new DeliveryState());
        state.wakeups().offer(reason);
        if (!state.running().compareAndSet(false, true)) {
            return;
        }
        deliveryExecutor.submit(() -> runDeliveryWorker(clientId, state));
    }

    private void runDeliveryWorker(String clientId, DeliveryState state) {
        try {
            while (true) {
                String reason;
                try {
                    reason = state.wakeups().poll(30, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
                if (reason == null) {
                    break;
                }

                String currentReason = reason;
                while (true) {
                    int pushed;
                    try {
                        pushed = deliverAvailableEvents(clientId, currentReason);
                    } catch (RuntimeException ex) {
                        // 单次投递失败不能让 worker 退出——否则要等下次 wakeup 才能复活，
                        // 期间会出现 30s 投递空窗。
                        log.warn("投递循环异常已捕获: clientId={} reason={} error={}", clientId, currentReason, ex.toString());
                        break;
                    }
                    String nextReason;
                    boolean hasWakeup = false;
                    while ((nextReason = state.wakeups().poll()) != null) {
                        currentReason = nextReason;
                        hasWakeup = true;
                    }
                    if (pushed > 0) {
                        currentReason = currentReason + "-drain";
                        continue;
                    }
                    if (!hasWakeup) {
                        break;
                    }
                }
            }
        } finally {
            state.running().set(false);
            if (!state.wakeups().isEmpty() && state.running().compareAndSet(false, true)) {
                deliveryExecutor.submit(() -> runDeliveryWorker(clientId, state));
            }
        }
    }

    private int deliverAvailableEvents(String clientId, String reason) {
        Map<String, String> staleSessions = sessions.closeStaleSessions(
                System.currentTimeMillis() - SESSION_IDLE_TIMEOUT_MS,
                "pre-delivery-heartbeat-timeout"
        );
        String staleSessionId = staleSessions.get(clientId);
        if (staleSessionId != null) {
            int requeued = eventStore.requeueSessionEvents(clientId, staleSessionId, "pre-delivery-heartbeat-timeout");
            log.warn(
                    "投递前先关闭过期会话: clientId={} sessionId={} requeued={}",
                    clientId,
                    staleSessionId,
                    requeued
            );
        }
        if (!sessions.hasOpenSession(clientId)) {
            log.info("消息投递跳过: clientId={} reason={} cause=session-offline", clientId, reason);
            return 0;
        }
        String currentSessionId = sessions.currentSessionId(clientId);
        int expired = sessions.expireInFlightOlderThan(clientId, System.currentTimeMillis() - IN_FLIGHT_LEASE_MS);
        if (expired > 0) {
            log.warn("消息投递中止: clientId={} reason={} cause=stale-inflight expiredCount={} action=close-session", clientId, reason, expired);
            eventStore.requeueSessionEvents(clientId, currentSessionId, "in-flight-timeout");
            sessions.closeSession(clientId, "in-flight-timeout");
            return 0;
        }
        Map<String, String> inFlightSnapshot = sessions.inFlightSnapshot(clientId);
        List<ImEvent> events = eventStore.findDeliverableEvents(clientId, 100);
        log.info(
                "开始消息投递: clientId={} reason={} candidateCount={} inFlightCount={} expiredCount={} firstCandidate={}",
                clientId,
                reason,
                events.size(),
                inFlightSnapshot.size(),
                expired,
                events.isEmpty() ? Map.of() : LogSummaries.summarizeEvent(events.get(0))
        );
        int pushed = 0;
        for (ImEvent event : events) {
            if (sessions.isInFlight(clientId, event.eventId())) {
                log.info("消息投递中止: clientId={} reason={} cause=event-still-inflight eventId={}", clientId, reason, event.eventId());
                break;
            }
            boolean pushedThisEvent = sessions.pushEvent(event);
            log.info("单条消息投递结果: clientId={} reason={} eventId={} pushed={}", clientId, reason, event.eventId(), pushedThisEvent);
            if (!pushedThisEvent) {
                break;
            }
            String sessionId = sessions.currentSessionId(clientId);
            if (sessionId != null && !sessionId.isBlank()) {
                eventStore.markLeased(event.eventId(), sessionId, Instant.now().plusMillis(IN_FLIGHT_LEASE_MS));
            }
            pushed += 1;
        }
        log.info(
            "消息投递结束: clientId={} reason={} candidateCount={} pushed={} firstCandidate={}",
            clientId,
            reason,
            events.size(),
            pushed,
            events.isEmpty() ? Map.of() : LogSummaries.summarizeEvent(events.get(0))
        );
        return pushed;
    }

    private void sweepOpenSessions() {
        try {
            Map<String, String> closedSessions = sessions.closeStaleSessions(
                    System.currentTimeMillis() - SESSION_IDLE_TIMEOUT_MS,
                    "heartbeat-timeout"
            );
            closedSessions.forEach((clientId, sessionId) -> {
                int requeued = eventStore.requeueSessionEvents(clientId, sessionId, "heartbeat-timeout");
                log.warn(
                        "心跳超时会话已回收：clientId={} sessionId={} requeued={}",
                        clientId,
                        sessionId,
                        requeued
                );
                requestDelivery(clientId, "heartbeat-timeout");
            });
        } catch (Exception ex) {
            log.warn("心跳超时会话回收失败：error={}", ex.toString());
        }
        // 兜底救援：扫描 deliveryLeaseUntil 已过期的 received 事件并退回 pending。
        // 这是修复"事件锁死在某个老 sessionId、永远不投递"的关键路径。
        try {
            List<ImEventStore.StaleLease> staleLeases = eventStore.findStaleLeases(Instant.now());
            int requeued = eventStore.sweepStaleLeases(Instant.now());
            if (requeued > 0) {
                for (ImEventStore.StaleLease lease : staleLeases) {
                    if (lease.clientId() == null || lease.clientId().isBlank()) {
                        continue;
                    }
                    sessions.closeSession(lease.clientId(), "stale-lease:" + lease.eventId());
                    log.warn(
                            "过期租约触发关闭会话: clientId={} sessionId={} eventId={}",
                            lease.clientId(),
                            lease.sessionId(),
                            lease.eventId()
                    );
                }
                for (String clientId : eventStore.findPendingClientIds()) {
                    requestDelivery(clientId, "stale-lease-sweep");
                }
            }
        } catch (Exception ex) {
            log.warn("过期租约巡检失败: error={}", ex.toString());
        }
        for (String clientId : sessions.openClientIds()) {
            try {
                requestDelivery(clientId, "periodic-sweep");
            } catch (Exception ex) {
                log.warn("周期投递巡检失败: clientId={} error={}", clientId, ex.toString());
            }
        }
    }

    private void scheduleDeliveryRetry(String clientId, String reason) {
        deliveryRetryExecutor.schedule(() -> {
            try {
                requestDelivery(clientId, reason + "-retry");
            } catch (Exception ex) {
                log.warn("延迟投递重试失败: clientId={} reason={} error={}", clientId, reason, ex.toString());
            }
        }, 1, TimeUnit.SECONDS);
    }

    private static ThreadFactory namedThread(String name) {
        return runnable -> {
            Thread thread = new Thread(runnable, name);
            thread.setDaemon(true);
            return thread;
        };
    }

    @PreDestroy
    void shutdownExecutors() {
        deliveryExecutor.shutdownNow();
        deliveryRetryExecutor.shutdownNow();
        deliverySweepExecutor.shutdownNow();
    }

    private record DeliveryState(
            AtomicBoolean running,
            BlockingQueue<String> wakeups
    ) {
        private DeliveryState() {
            this(new AtomicBoolean(false), new LinkedBlockingQueue<>());
        }
    }
}

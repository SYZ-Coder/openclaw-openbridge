package ai.openclaw.demo.springim.service;

import ai.openclaw.demo.springim.dao.DeviceDao;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * Session binding service for multi-instance coordination.
 *
 * Manages session bindings in SQLite database to support multi-instance deployments.
 * Each instance writes its session bindings to the database, allowing other instances
 * to detect stale bindings and coordinate message delivery.
 */
@Service
public class SessionBindingService {
    private static final Logger log = LoggerFactory.getLogger(SessionBindingService.class);
    private static final long SESSION_TIMEOUT_MS = 60_000; // 60 seconds

    private final DeviceDao deviceDao;
    private final String instanceId;

    public SessionBindingService(DeviceDao deviceDao) {
        this.deviceDao = deviceDao;
        this.instanceId = "inst-" + UUID.randomUUID().toString().substring(0, 8);
        log.info("SessionBindingService initialized: instanceId={}", instanceId);
    }

    /**
     * Get the current instance identifier.
     */
    public String getInstanceId() {
        return instanceId;
    }

    /**
     * Register or update a session binding for a client.
     */
    public void bindSession(String clientId, String sessionId) {
        long now = Instant.now().toEpochMilli();
        deviceDao.updateSessionBinding(clientId, instanceId, sessionId, now);
        log.info("Session bound: clientId={} sessionId={} instanceId={}", clientId, sessionId, instanceId);
    }

    /**
     * Clear a session binding for a client.
     */
    public void unbindSession(String clientId) {
        deviceDao.clearSessionBinding(clientId);
        log.info("Session unbound: clientId={} instanceId={}", clientId, instanceId);
    }

    /**
     * Update last seen timestamp for a session.
     */
    public void touchSession(String clientId) {
        long now = Instant.now().toEpochMilli();
        deviceDao.updateSessionBinding(clientId, instanceId, instanceId + "-" + now, now);
    }

    /**
     * Find stale session bindings that haven't been updated recently.
     */
    public List<DeviceDao.SessionBinding> findStaleBindings() {
        long cutoff = Instant.now().toEpochMilli() - SESSION_TIMEOUT_MS;
        return deviceDao.findStaleSessionBindings(cutoff);
    }

    /**
     * Check if a client has an active session binding on this instance.
     */
    public boolean hasActiveBinding(String clientId) {
        // This would need additional query in DeviceDao
        return true; // For now, assume local check
    }

    /**
     * Scheduled task to clean up stale session bindings.
     */
    @Scheduled(fixedRate = 30_000)
    public void cleanupStaleBindings() {
        List<DeviceDao.SessionBinding> stale = findStaleBindings();
        if (!stale.isEmpty()) {
            log.info("Cleaning up stale session bindings: count={}", stale.size());
            for (DeviceDao.SessionBinding binding : stale) {
                deviceDao.clearSessionBinding(binding.clientId());
                log.info("Cleared stale binding: clientId={} instanceId={} lastSeenAt={}",
                        binding.clientId(), binding.instanceId(), binding.lastSeenAt());
            }
        }
    }
}
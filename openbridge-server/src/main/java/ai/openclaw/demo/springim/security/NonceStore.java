package ai.openclaw.demo.springim.security;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class NonceStore {
    private static final Duration TTL = Duration.ofMinutes(10);

    private final Map<String, Long> seen = new ConcurrentHashMap<>();

    public boolean seen(String nonce) {
        prune();
        return nonce != null && seen.containsKey(nonce);
    }

    public void mark(String nonce) {
        if (nonce == null || nonce.isBlank()) {
            return;
        }
        prune();
        seen.put(nonce, System.currentTimeMillis());
    }

    private void prune() {
        long now = System.currentTimeMillis();
        seen.entrySet().removeIf(entry -> now - entry.getValue() > TTL.toMillis());
    }
}

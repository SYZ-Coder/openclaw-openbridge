package ai.openclaw.demo.springim.model;

import java.time.Instant;

public record ClientRegistry(
        String clientId,
        String deviceId,
        String ownerUserId,
        String tokenHash,
        String clientSecretHash,
        String rawToken,
        String rawClientSecret,
        Instant issuedAt,
        Instant revokedAt,
        Instant expiresAt,
        String status
) {
}

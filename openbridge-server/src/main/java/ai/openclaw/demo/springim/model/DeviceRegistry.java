package ai.openclaw.demo.springim.model;

import java.time.Instant;

public record DeviceRegistry(
        String deviceId,
        String deviceName,
        String devicePublicKey,
        String deviceFingerprint,
        String installId,
        Instant firstSeenAt,
        Instant lastSeenAt,
        String status
) {
}

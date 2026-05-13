package ai.openclaw.demo.springim.model;

import java.time.Instant;

public record DeviceOwnerBinding(
        String deviceId,
        String ownerUserId,
        Instant boundAt,
        Instant unboundAt,
        String status
) {
}

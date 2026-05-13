package ai.openclaw.demo.springim.model;

import java.time.Instant;

public record DeviceTransferAudit(
        String deviceId,
        String fromUserId,
        String toUserId,
        String oldClientId,
        String newClientId,
        String transferReason,
        String operatorId,
        Instant transferredAt
) {
}

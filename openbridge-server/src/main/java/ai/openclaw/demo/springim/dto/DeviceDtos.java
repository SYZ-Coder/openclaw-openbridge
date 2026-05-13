package ai.openclaw.demo.springim.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

public final class DeviceDtos {
    private DeviceDtos() {
    }

    public record DeviceRegisterRequest(
            String deviceId,
            String installId,
            String deviceName,
            String publicKeyPem,
            String deviceFingerprint,
            String ownerUserId
    ) {
    }

    public record DeviceRegisterResponse(
            String deviceId,
            String clientId,
            String token,
            String clientSecret,
            String ownerUserId
    ) {
    }

    public record DeviceRebindRequest(
            String deviceId,
            String targetUserId,
            long timestamp,
            String nonce,
            String signature
    ) {
    }

    public record DeviceRebindResponse(
            String deviceId,
            String clientId,
            String token,
            String clientSecret,
            String ownerUserId
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ClientHelloV2(
            String type,
            int protocolVersion,
            String deviceId,
            String clientId,
            String accountId,
            long timestamp,
            String nonce,
            String signature,
            Long lastProcessedSequence,
            String lastProcessedEventId
    ) {
    }
}

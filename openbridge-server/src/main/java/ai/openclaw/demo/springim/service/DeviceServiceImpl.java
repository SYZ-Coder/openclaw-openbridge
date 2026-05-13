package ai.openclaw.demo.springim.service;

import ai.openclaw.demo.springim.config.OpenClawBridgeProperties;
import ai.openclaw.demo.springim.dao.DeviceDao;
import ai.openclaw.demo.springim.dto.DeviceDtos.ClientHelloV2;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRebindRequest;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRebindResponse;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRegisterRequest;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRegisterResponse;
import ai.openclaw.demo.springim.model.ClientRegistry;
import ai.openclaw.demo.springim.model.DeviceOwnerBinding;
import ai.openclaw.demo.springim.model.DeviceRegistry;
import ai.openclaw.demo.springim.model.DeviceTransferAudit;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Device service with SQLite persistence.
 *
 * All device, client, and binding operations are persisted through DeviceDao.
 */
@Service
public class DeviceServiceImpl implements DeviceService {
    private static final Logger log = LoggerFactory.getLogger(DeviceServiceImpl.class);
    private static final Duration HELLO_WINDOW = Duration.ofMinutes(5);
    private static final long NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    private final OpenClawBridgeProperties properties;
    private final DeviceDao deviceDao;

    public DeviceServiceImpl(OpenClawBridgeProperties properties, DeviceDao deviceDao) {
        this.properties = properties;
        this.deviceDao = deviceDao;
        log.info("DeviceServiceImpl initialized with SQLite DAO");
    }

    @Override
    public DeviceRegisterResponse registerDevice(String authenticatedClientId, DeviceRegisterRequest request) {
        log.info("device register request: clientId={} deviceId={} installId={} ownerUserId={}",
                authenticatedClientId, request.deviceId(), request.installId(), request.ownerUserId());

        // Check existing device
        DeviceRegistry existing = deviceDao.findByDeviceId(request.deviceId());
        DeviceRegistry device;
        if (existing == null) {
            device = new DeviceRegistry(
                    request.deviceId(),
                    request.deviceName(),
                    request.publicKeyPem(),
                    request.deviceFingerprint(),
                    request.installId(),
                    Instant.now(),
                    Instant.now(),
                    "ACTIVE"
            );
            deviceDao.insertDevice(device);
        } else {
            device = new DeviceRegistry(
                    existing.deviceId(),
                    request.deviceName() == null || request.deviceName().isBlank() ? existing.deviceName() : request.deviceName(),
                    request.publicKeyPem() == null || request.publicKeyPem().isBlank() ? existing.devicePublicKey() : request.publicKeyPem(),
                    request.deviceFingerprint() == null || request.deviceFingerprint().isBlank()
                            ? existing.deviceFingerprint()
                            : request.deviceFingerprint(),
                    request.installId() == null || request.installId().isBlank() ? existing.installId() : request.installId(),
                    existing.firstSeenAt(),
                    Instant.now(),
                    "ACTIVE"
            );
            deviceDao.updateDevice(device);
        }

        // Determine owner user ID
        DeviceOwnerBinding existingBinding = deviceDao.findByBindingDeviceId(request.deviceId());
        String ownerUserId = request.ownerUserId() != null && !request.ownerUserId().isBlank()
                ? request.ownerUserId()
                : existingBinding != null ? existingBinding.ownerUserId() : "user-default";

        // Update binding
        DeviceOwnerBinding binding = new DeviceOwnerBinding(
                request.deviceId(),
                ownerUserId,
                Instant.now(),
                "ACTIVE"
        );
        deviceDao.insertBinding(binding);

        // Check or create client
        ClientRegistry client = deviceDao.findByClientId(authenticatedClientId);
        if (client == null) {
            OpenClawBridgeProperties.Client configured = properties.requireClient(authenticatedClientId);
            client = new ClientRegistry(
                    authenticatedClientId,
                    request.deviceId(),
                    ownerUserId,
                    hash(configured.getToken()),
                    configured.getClientSecret() == null ? null : hash(configured.getClientSecret()),
                    configured.getToken(),
                    configured.getClientSecret(),
                    Instant.now(),
                    null,
                    null,
                    "ACTIVE"
            );
            deviceDao.insertClient(client);
        } else if (!request.deviceId().equals(client.deviceId())) {
            client = new ClientRegistry(
                    client.clientId(),
                    request.deviceId(),
                    ownerUserId,
                    client.tokenHash(),
                    client.clientSecretHash(),
                    client.rawToken(),
                    client.rawClientSecret(),
                    client.issuedAt(),
                    null,
                    client.expiresAt(),
                    "ACTIVE"
            );
            deviceDao.updateClient(client);
        }

        DeviceRegisterResponse response = new DeviceRegisterResponse(
                request.deviceId(),
                client.clientId(),
                client.rawToken(),
                client.rawClientSecret(),
                ownerUserId
        );
        log.info("device register response: clientId={} deviceId={} ownerUserId={}",
                response.clientId(), response.deviceId(), response.ownerUserId());
        return response;
    }

    @Override
    public DeviceRebindResponse rebindDevice(DeviceRebindRequest request) {
        log.info("device rebind request: deviceId={} targetUserId={}", request.deviceId(), request.targetUserId());
        DeviceRegistry device = requireDevice(request.deviceId());
        verifyRebindSignature(device, request);

        DeviceOwnerBinding oldBinding = deviceDao.findByBindingDeviceId(request.deviceId());
        String fromUserId = oldBinding == null ? null : oldBinding.ownerUserId();
        ClientRegistry oldClient = deviceDao.findActiveClientByDeviceId(request.deviceId());
        if (oldClient != null) {
            revokeClient(oldClient.clientId());
        }

        // Create new binding
        DeviceOwnerBinding newBinding = new DeviceOwnerBinding(
                request.deviceId(),
                request.targetUserId(),
                Instant.now(),
                "ACTIVE"
        );
        deviceDao.insertBinding(newBinding);

        // Create new client
        String newClientId = "oc-" + request.targetUserId() + "-" + System.currentTimeMillis();
        String token = "tok-" + java.util.UUID.randomUUID();
        String clientSecret = "sec-" + java.util.UUID.randomUUID();
        ClientRegistry newClient = new ClientRegistry(
                newClientId,
                request.deviceId(),
                request.targetUserId(),
                hash(token),
                hash(clientSecret),
                token,
                clientSecret,
                Instant.now(),
                null,
                null,
                "ACTIVE"
        );
        deviceDao.insertClient(newClient);

        // Audit transfer
        DeviceTransferAudit audit = new DeviceTransferAudit(
                request.deviceId(),
                fromUserId,
                request.targetUserId(),
                oldClient == null ? null : oldClient.clientId(),
                newClientId,
                "device rebind",
                "system",
                Instant.now()
        );
        deviceDao.insertAudit(audit);

        DeviceRebindResponse response = new DeviceRebindResponse(
                request.deviceId(),
                newClient.clientId(),
                newClient.rawToken(),
                newClient.rawClientSecret(),
                request.targetUserId()
        );
        log.info("device rebind response: deviceId={} newClientId={} targetUserId={}",
                response.deviceId(), response.clientId(), response.ownerUserId());
        return response;
    }

    @Override
    public void revokeDevice(String deviceId) {
        log.info("device revoke request: deviceId={}", deviceId);
        DeviceRegistry device = requireDevice(deviceId);
        DeviceRegistry revoked = new DeviceRegistry(
                device.deviceId(),
                device.deviceName(),
                device.devicePublicKey(),
                device.deviceFingerprint(),
                device.installId(),
                device.firstSeenAt(),
                Instant.now(),
                "REVOKED"
        );
        deviceDao.updateDevice(revoked);

        ClientRegistry activeClient = deviceDao.findActiveClientByDeviceId(deviceId);
        if (activeClient != null) {
            revokeClient(activeClient.clientId());
        }
        log.info("device revoked: deviceId={} activeClientId={}", deviceId, activeClient == null ? null : activeClient.clientId());
    }

    @Override
    public boolean verifyHello(ClientHelloV2 hello) {
        ClientRegistry client = deviceDao.findByClientId(hello.clientId());
        if (client == null || !"ACTIVE".equals(client.status())) {
            log.warn("hello verify failed: reason=unknown-client clientId={} deviceId={}", hello.clientId(), hello.deviceId());
            return false;
        }
        if (!client.deviceId().equals(hello.deviceId())) {
            log.warn("hello verify failed: reason=device-mismatch clientId={} expectedDeviceId={} actualDeviceId={}",
                    hello.clientId(), client.deviceId(), hello.deviceId());
            return false;
        }
        if (deviceDao.hasNonce(hello.nonce())) {
            log.warn("hello verify failed: reason=nonce-reused clientId={} nonce={}", hello.clientId(), hello.nonce());
            return false;
        }
        long now = Instant.now().toEpochMilli();
        if (Math.abs(now - hello.timestamp()) > HELLO_WINDOW.toMillis()) {
            log.warn("hello verify failed: reason=timestamp-window clientId={} timestamp={}", hello.clientId(), hello.timestamp());
            return false;
        }
        DeviceRegistry device = requireDevice(hello.deviceId());
        boolean ok = verifySignature(
                device.devicePublicKey(),
                String.join(".",
                        hello.deviceId(),
                        hello.clientId(),
                        hello.accountId(),
                        String.valueOf(hello.timestamp()),
                        hello.nonce()),
                hello.signature()
        );
        if (ok) {
            deviceDao.markNonce(hello.nonce(), now + NONCE_TTL_MS);
            pruneNonces();
            DeviceRegistry updated = new DeviceRegistry(
                    device.deviceId(),
                    device.deviceName(),
                    device.devicePublicKey(),
                    device.deviceFingerprint(),
                    device.installId(),
                    device.firstSeenAt(),
                    Instant.now(),
                    device.status()
            );
            deviceDao.updateDevice(updated);
        }
        log.info("hello verify result: clientId={} deviceId={} ok={}", hello.clientId(), hello.deviceId(), ok);
        return ok;
    }

    @Override
    public boolean verifyToken(String clientId, String token) {
        ClientRegistry issued = deviceDao.findByClientId(clientId);
        boolean ok = issued != null
                && issued.rawToken() != null
                && constantTimeEquals(issued.rawToken(), token)
                && "ACTIVE".equals(issued.status());
        log.info("issued token verify result: clientId={} ok={}", clientId, ok);
        return ok;
    }

    @Override
    public String resolveClientSecret(String clientId) {
        ClientRegistry issued = deviceDao.findByClientId(clientId);
        if (issued == null || !"ACTIVE".equals(issued.status())) {
            return null;
        }
        return issued.rawClientSecret();
    }

    private DeviceRegistry requireDevice(String deviceId) {
        DeviceRegistry device = deviceDao.findByDeviceId(deviceId);
        if (device == null) {
            throw new IllegalArgumentException("Unknown deviceId: " + deviceId);
        }
        return device;
    }

    private void revokeClient(String clientId) {
        ClientRegistry client = deviceDao.findByClientId(clientId);
        if (client == null) {
            return;
        }
        ClientRegistry revoked = new ClientRegistry(
                client.clientId(),
                client.deviceId(),
                client.ownerUserId(),
                client.tokenHash(),
                client.clientSecretHash(),
                client.rawToken(),
                client.rawClientSecret(),
                client.issuedAt(),
                Instant.now(),
                client.expiresAt(),
                "REVOKED"
        );
        deviceDao.updateClient(revoked);
    }

    private void verifyRebindSignature(DeviceRegistry device, DeviceRebindRequest request) {
        long now = Instant.now().toEpochMilli();
        if (Math.abs(now - request.timestamp()) > HELLO_WINDOW.toMillis()) {
            throw new SecurityException("rebind request expired");
        }
        if (deviceDao.hasNonce(request.nonce())) {
            throw new SecurityException("rebind nonce already used");
        }
        String payload = String.join(".",
                request.deviceId(),
                request.targetUserId(),
                String.valueOf(request.timestamp()),
                request.nonce());
        if (!verifySignature(device.devicePublicKey(), payload, request.signature())) {
            throw new SecurityException("invalid rebind signature");
        }
        deviceDao.markNonce(request.nonce(), now + NONCE_TTL_MS);
    }

    private boolean verifySignature(String publicKeyPem, String payload, String signatureBase64) {
        try {
            String normalized = publicKeyPem
                    .replace("-----BEGIN PUBLIC KEY-----", "")
                    .replace("-----END PUBLIC KEY-----", "")
                    .replaceAll("\\s+", "");
            byte[] der = Base64.getDecoder().decode(normalized);
            PublicKey publicKey = KeyFactory.getInstance("Ed25519")
                    .generatePublic(new X509EncodedKeySpec(der));
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(publicKey);
            verifier.update(payload.getBytes(StandardCharsets.UTF_8));
            return verifier.verify(Base64.getDecoder().decode(signatureBase64));
        } catch (Exception e) {
            throw new IllegalStateException("unable to verify signature", e);
        }
    }

    private static String hash(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return Base64.getEncoder().encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8))
            );
        } catch (Exception e) {
            throw new IllegalStateException("unable to hash secret", e);
        }
    }

    private static boolean constantTimeEquals(String left, String right) {
        if (left == null || right == null) {
            return false;
        }
        return MessageDigest.isEqual(
                left.getBytes(StandardCharsets.UTF_8),
                right.getBytes(StandardCharsets.UTF_8)
        );
    }

    private void pruneNonces() {
        long cutoff = Instant.now().toEpochMilli() - NONCE_TTL_MS;
        deviceDao.pruneNonce(cutoff);
    }
}
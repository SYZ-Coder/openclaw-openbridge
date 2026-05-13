package ai.openclaw.demo.springim.security;

import ai.openclaw.demo.springim.config.OpenClawBridgeProperties;
import ai.openclaw.demo.springim.service.DeviceService;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

/**
 * 杩欎釜鏈嶅姟璐熻矗鏍￠獙 OpenClaw 鎻掍欢鍙戞潵鐨勮韩浠戒俊鎭€? *
 * 瀹冧紭鍏堜俊浠昏澶?瀹㈡埛绔敞鍐岃〃锛涘鏋滃綋鍓?clientId 杩樻病瀹屾垚璁惧娉ㄥ唽锛? * 鍐嶅洖閫€鍒?application.yml 涓殑闈欐€?client 閰嶇疆鍋?bootstrap銆? */
@Service
public class OpenClawAuthService {
    private static final Logger log = LoggerFactory.getLogger(OpenClawAuthService.class);
    private static final Duration SIGNATURE_WINDOW = Duration.ofMinutes(5);

    private final OpenClawBridgeProperties properties;
    private final DeviceService deviceService;

    public OpenClawAuthService(OpenClawBridgeProperties properties, DeviceService deviceService) {
        this.properties = properties;
        this.deviceService = deviceService;
    }

    public void verifyToken(String clientId, String token) {
        if (deviceService.verifyToken(clientId, token)) {
            log.info("openclaw token verified from issued registry: clientId={}", clientId);
            return;
        }
        OpenClawBridgeProperties.Client client = properties.requireClient(clientId);
        if (!StringUtils.hasText(client.getToken()) || !constantTimeEquals(client.getToken(), token)) {
            log.warn("openclaw token verification failed: clientId={}", clientId);
            throw new SecurityException("Invalid OpenClaw token");
        }
        log.info("openclaw token verified from static config: clientId={}", clientId);
    }

    public void verifyHttpRequest(String body, HttpServletRequest request) {
        String clientId = request.getHeader("x-openclaw-client-id");
        if (!StringUtils.hasText(clientId)) {
            throw new SecurityException("Missing x-openclaw-client-id");
        }
        String authorization = request.getHeader("authorization");
        String token = authorization != null && authorization.startsWith("Bearer ")
                ? authorization.substring("Bearer ".length())
                : null;
        log.info("openclaw http auth verify: method={} path={} clientId={} bodyLength={}", request.getMethod(), request.getRequestURI(), clientId, body == null ? 0 : body.length());
        verifyToken(clientId, token);

        String clientSecret = deviceService.resolveClientSecret(clientId);
        if (!StringUtils.hasText(clientSecret)) {
            OpenClawBridgeProperties.Client configured = properties.requireClient(clientId);
            clientSecret = configured.getClientSecret();
        }
        if (!StringUtils.hasText(clientSecret)) {
            log.info("openclaw http auth verified without signature secret: clientId={}", clientId);
            return;
        }

        String timestampHeader = request.getHeader("x-openclaw-timestamp");
        String requestId = request.getHeader("x-openclaw-request-id");
        String signature = request.getHeader("x-openclaw-signature");
        if (!StringUtils.hasText(timestampHeader) || !StringUtils.hasText(requestId) || !StringUtils.hasText(signature)) {
            throw new SecurityException("Missing OpenClaw signature headers");
        }

        long timestamp = Long.parseLong(timestampHeader);
        long now = Instant.now().toEpochMilli();
        if (Math.abs(now - timestamp) > SIGNATURE_WINDOW.toMillis()) {
            throw new SecurityException("OpenClaw signature timestamp expired");
        }

        String expected = hmacSha256(clientSecret, timestamp + "." + requestId + "." + body);
        if (!constantTimeEquals(expected, signature)) {
            log.warn("openclaw signature verification failed: clientId={} requestId={}", clientId, requestId);
            throw new SecurityException("Invalid OpenClaw signature");
        }
        log.info("openclaw signature verified: clientId={} requestId={} timestamp={}", clientId, requestId, timestamp);
    }

    private static String hmacSha256(String secret, String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("Unable to compute HMAC", e);
        }
    }

    private static boolean constantTimeEquals(String expected, String actual) {
        if (expected == null || actual == null) {
            return false;
        }
        return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8),
                actual.getBytes(StandardCharsets.UTF_8)
        );
    }
}

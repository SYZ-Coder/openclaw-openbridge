package ai.openclaw.demo.springim.web;

import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRebindRequest;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRebindResponse;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRegisterRequest;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRegisterResponse;
import ai.openclaw.demo.springim.security.OpenClawAuthService;
import ai.openclaw.demo.springim.service.DeviceService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.ContentCachingRequestWrapper;

@RestController
@RequestMapping("/api/openclaw/devices")
public class DeviceController {
    private final DeviceService deviceService;
    private final OpenClawAuthService authService;

    public DeviceController(DeviceService deviceService, OpenClawAuthService authService) {
        this.deviceService = deviceService;
        this.authService = authService;
    }

    @PostMapping("/register")
    public ResponseEntity<DeviceRegisterResponse> register(
            @Valid @RequestBody DeviceRegisterRequest request,
            @RequestHeader("x-openclaw-client-id") String clientId,
            HttpServletRequest servletRequest
    ) {
        authService.verifyHttpRequest(cachedBody(servletRequest), servletRequest);
        return ResponseEntity.ok(deviceService.registerDevice(clientId, request));
    }

    @PostMapping("/rebind")
    public ResponseEntity<DeviceRebindResponse> rebind(@Valid @RequestBody DeviceRebindRequest request) {
        return ResponseEntity.ok(deviceService.rebindDevice(request));
    }

    @PostMapping("/{deviceId}/revoke")
    public ResponseEntity<Map<String, Object>> revoke(@PathVariable String deviceId) {
        deviceService.revokeDevice(deviceId);
        return ResponseEntity.ok(Map.of("ok", true));
    }

    private static String cachedBody(HttpServletRequest request) {
        if (request instanceof ContentCachingRequestWrapper wrapper) {
            return new String(wrapper.getContentAsByteArray(), StandardCharsets.UTF_8);
        }
        return "";
    }
}

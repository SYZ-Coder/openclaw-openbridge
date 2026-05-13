package ai.openclaw.demo.springim.service;

import ai.openclaw.demo.springim.dto.DeviceDtos.ClientHelloV2;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRebindRequest;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRebindResponse;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRegisterRequest;
import ai.openclaw.demo.springim.dto.DeviceDtos.DeviceRegisterResponse;

public interface DeviceService {
    DeviceRegisterResponse registerDevice(String authenticatedClientId, DeviceRegisterRequest request);

    DeviceRebindResponse rebindDevice(DeviceRebindRequest request);

    void revokeDevice(String deviceId);

    boolean verifyHello(ClientHelloV2 hello);

    boolean verifyToken(String clientId, String token);

    String resolveClientSecret(String clientId);
}

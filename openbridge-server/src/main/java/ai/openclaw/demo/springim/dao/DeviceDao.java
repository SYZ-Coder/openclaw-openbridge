package ai.openclaw.demo.springim.dao;

import ai.openclaw.demo.springim.model.ClientRegistry;
import ai.openclaw.demo.springim.model.DeviceOwnerBinding;
import ai.openclaw.demo.springim.model.DeviceRegistry;
import ai.openclaw.demo.springim.model.DeviceTransferAudit;
import java.util.List;

/**
 * Data Access Object for device registration.
 *
 * Provides CRUD operations for devices, clients, bindings, and audits tables.
 */
public interface DeviceDao {

    // Device operations
    DeviceRegistry insertDevice(DeviceRegistry device);
    DeviceRegistry updateDevice(DeviceRegistry device);
    DeviceRegistry findByDeviceId(String deviceId);
    List<DeviceRegistry> findAllDevices();

    // Client operations
    ClientRegistry insertClient(ClientRegistry client);
    ClientRegistry updateClient(ClientRegistry client);
    ClientRegistry findByClientId(String clientId);
    ClientRegistry findActiveClientByDeviceId(String deviceId);
    List<ClientRegistry> findAllClients();

    // Device-Owner binding operations
    DeviceOwnerBinding insertBinding(DeviceOwnerBinding binding);
    DeviceOwnerBinding updateBinding(DeviceOwnerBinding binding);
    DeviceOwnerBinding findByBindingDeviceId(String deviceId);
    List<DeviceOwnerBinding> findAllBindings();

    // Transfer audit operations
    DeviceTransferAudit insertAudit(DeviceTransferAudit audit);
    List<DeviceTransferAudit> findAuditsByDeviceId(String deviceId);

    // Nonce operations (for anti-replay)
    boolean hasNonce(String nonce);
    void markNonce(String nonce, long expiresAt);
    void pruneNonce(long cutoff);

    // Session binding operations (for multi-instance support)
    int updateSessionBinding(String clientId, String instanceId, String sessionId, long lastSeenAt);
    int clearSessionBinding(String clientId);
    List<SessionBinding> findStaleSessionBindings(long cutoff);

    /**
     * Session binding record.
     */
    record SessionBinding(String clientId, String instanceId, String sessionId, long boundAt, long lastSeenAt, String status) {}
}
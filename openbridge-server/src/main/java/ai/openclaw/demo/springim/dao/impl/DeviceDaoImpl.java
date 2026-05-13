package ai.openclaw.demo.springim.dao.impl;

import ai.openclaw.demo.springim.dao.DeviceDao;
import ai.openclaw.demo.springim.model.ClientRegistry;
import ai.openclaw.demo.springim.model.DeviceOwnerBinding;
import ai.openclaw.demo.springim.model.DeviceRegistry;
import ai.openclaw.demo.springim.model.DeviceTransferAudit;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * JDBC implementation of DeviceDao using SQLite.
 */
@Repository
public class DeviceDaoImpl implements DeviceDao {
    private static final Logger log = LoggerFactory.getLogger(DeviceDaoImpl.class);

    private final JdbcTemplate jdbcTemplate;

    // Device SQL
    private static final String INSERT_DEVICE_SQL =
            "INSERT INTO devices (device_id, install_id, device_name, public_key_pem, fingerprint, first_seen_at, last_seen_at, status) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

    private static final String UPDATE_DEVICE_SQL =
            "UPDATE devices SET device_name = ?, public_key_pem = ?, fingerprint = ?, install_id = ?, last_seen_at = ?, status = ? " +
            "WHERE device_id = ?";

    private static final String FIND_DEVICE_BY_ID_SQL = "SELECT * FROM devices WHERE device_id = ?";

    private static final String FIND_ALL_DEVICES_SQL = "SELECT * FROM devices ORDER BY last_seen_at DESC";

    // Client SQL
    private static final String INSERT_CLIENT_SQL =
            "INSERT INTO clients (client_id, device_id, owner_user_id, token, client_secret, issued_at, revoked_at, status) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

    private static final String UPDATE_CLIENT_SQL =
            "UPDATE clients SET device_id = ?, owner_user_id = ?, token = ?, client_secret = ?, revoked_at = ?, status = ? " +
            "WHERE client_id = ?";

    private static final String FIND_CLIENT_BY_ID_SQL = "SELECT * FROM clients WHERE client_id = ?";

    private static final String FIND_ACTIVE_CLIENT_BY_DEVICE_SQL =
            "SELECT * FROM clients WHERE device_id = ? AND status = 'ACTIVE' LIMIT 1";

    private static final String FIND_ALL_CLIENTS_SQL = "SELECT * FROM clients ORDER BY issued_at DESC";

    // Binding SQL
    private static final String INSERT_BINDING_SQL =
            "INSERT OR REPLACE INTO device_owner_bindings (device_id, owner_user_id, bound_at, status) " +
            "VALUES (?, ?, ?, ?)";

    private static final String FIND_BINDING_BY_DEVICE_SQL =
            "SELECT * FROM device_owner_bindings WHERE device_id = ?";

    private static final String FIND_ALL_BINDINGS_SQL = "SELECT * FROM device_owner_bindings";

    // Audit SQL
    private static final String INSERT_AUDIT_SQL =
            "INSERT INTO device_transfer_audits (device_id, from_user_id, to_user_id, from_client_id, to_client_id, reason, actor, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

    private static final String FIND_AUDITS_BY_DEVICE_SQL =
            "SELECT * FROM device_transfer_audits WHERE device_id = ? ORDER BY created_at DESC";

    // Nonce SQL
    private static final String HAS_NONCE_SQL = "SELECT 1 FROM nonces WHERE nonce = ?";

    private static final String MARK_NONCE_SQL =
            "INSERT INTO nonces (nonce, created_at) VALUES (?, ?)";

    private static final String PRUNE_NONCE_SQL = "DELETE FROM nonces WHERE created_at < ?";

    // Session binding SQL
    private static final String UPDATE_SESSION_BINDING_SQL =
            "INSERT OR REPLACE INTO session_bindings (client_id, instance_id, session_id, bound_at, last_seen_at, status) " +
            "VALUES (?, ?, ?, strftime('%s','now') * 1000, ?, 'ACTIVE')";

    private static final String CLEAR_SESSION_BINDING_SQL =
            "UPDATE session_bindings SET status = 'INACTIVE', last_seen_at = strftime('%s','now') * 1000 WHERE client_id = ?";

    private static final String FIND_STALE_SESSION_BINDINGS_SQL =
            "SELECT client_id, instance_id, session_id, bound_at, last_seen_at, status FROM session_bindings " +
            "WHERE status = 'ACTIVE' AND last_seen_at < ?";

    // Row mappers
    private final RowMapper<DeviceRegistry> deviceRowMapper = (rs, rowNum) -> new DeviceRegistry(
            rs.getString("device_id"),
            rs.getString("device_name"),
            rs.getString("public_key_pem"),
            rs.getString("fingerprint"),
            rs.getString("install_id"),
            Instant.ofEpochMilli(rs.getLong("first_seen_at")),
            Instant.ofEpochMilli(rs.getLong("last_seen_at")),
            rs.getString("status")
    );

    private final RowMapper<ClientRegistry> clientRowMapper = (rs, rowNum) -> new ClientRegistry(
            rs.getString("client_id"),
            rs.getString("device_id"),
            rs.getString("owner_user_id"),
            null, // tokenHash not stored
            null, // clientSecretHash not stored
            rs.getString("token"),
            rs.getString("client_secret"),
            Instant.ofEpochMilli(rs.getLong("issued_at")),
            rs.getLong("revoked_at") > 0 ? Instant.ofEpochMilli(rs.getLong("revoked_at")) : null,
            null, // expiresAt not stored
            rs.getString("status")
    );

    private final RowMapper<DeviceOwnerBinding> bindingRowMapper = (rs, rowNum) -> new DeviceOwnerBinding(
            rs.getString("device_id"),
            rs.getString("owner_user_id"),
            Instant.ofEpochMilli(rs.getLong("bound_at")),
            null, // unboundAt not stored
            rs.getString("status")
    );

    private final RowMapper<DeviceTransferAudit> auditRowMapper = (rs, rowNum) -> new DeviceTransferAudit(
            rs.getString("device_id"),
            rs.getString("from_user_id"),
            rs.getString("to_user_id"),
            rs.getString("from_client_id"),
            rs.getString("to_client_id"),
            rs.getString("reason"),
            rs.getString("actor"),
            Instant.ofEpochMilli(rs.getLong("created_at"))
    );

    private final RowMapper<SessionBinding> sessionBindingRowMapper = (rs, rowNum) -> new SessionBinding(
            rs.getString("client_id"),
            rs.getString("instance_id"),
            rs.getString("session_id"),
            rs.getLong("bound_at"),
            rs.getLong("last_seen_at"),
            rs.getString("status")
    );

    public DeviceDaoImpl(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public DeviceRegistry insertDevice(DeviceRegistry device) {
        jdbcTemplate.update(INSERT_DEVICE_SQL,
                device.deviceId(),
                device.installId(),
                device.deviceName(),
                device.devicePublicKey(),
                device.deviceFingerprint(),
                device.firstSeenAt().toEpochMilli(),
                device.lastSeenAt().toEpochMilli(),
                device.status()
        );
        log.info("Device inserted: deviceId={}", device.deviceId());
        return device;
    }

    @Override
    public DeviceRegistry updateDevice(DeviceRegistry device) {
        jdbcTemplate.update(UPDATE_DEVICE_SQL,
                device.deviceName(),
                device.devicePublicKey(),
                device.deviceFingerprint(),
                device.installId(),
                device.lastSeenAt().toEpochMilli(),
                device.status(),
                device.deviceId()
        );
        return device;
    }

    @Override
    public DeviceRegistry findByDeviceId(String deviceId) {
        List<DeviceRegistry> results = jdbcTemplate.query(FIND_DEVICE_BY_ID_SQL, deviceRowMapper, deviceId);
        return results.isEmpty() ? null : results.get(0);
    }

    @Override
    public List<DeviceRegistry> findAllDevices() {
        return jdbcTemplate.query(FIND_ALL_DEVICES_SQL, deviceRowMapper);
    }

    @Override
    public ClientRegistry insertClient(ClientRegistry client) {
        jdbcTemplate.update(INSERT_CLIENT_SQL,
                client.clientId(),
                client.deviceId(),
                client.ownerUserId(),
                client.rawToken(),
                client.rawClientSecret(),
                client.issuedAt().toEpochMilli(),
                client.revokedAt() != null ? client.revokedAt().toEpochMilli() : null,
                client.status()
        );
        log.info("Client inserted: clientId={} deviceId={}", client.clientId(), client.deviceId());
        return client;
    }

    @Override
    public ClientRegistry updateClient(ClientRegistry client) {
        jdbcTemplate.update(UPDATE_CLIENT_SQL,
                client.deviceId(),
                client.ownerUserId(),
                client.rawToken(),
                client.rawClientSecret(),
                client.revokedAt() != null ? client.revokedAt().toEpochMilli() : null,
                client.status(),
                client.clientId()
        );
        return client;
    }

    @Override
    public ClientRegistry findByClientId(String clientId) {
        List<ClientRegistry> results = jdbcTemplate.query(FIND_CLIENT_BY_ID_SQL, clientRowMapper, clientId);
        return results.isEmpty() ? null : results.get(0);
    }

    @Override
    public ClientRegistry findActiveClientByDeviceId(String deviceId) {
        List<ClientRegistry> results = jdbcTemplate.query(FIND_ACTIVE_CLIENT_BY_DEVICE_SQL, clientRowMapper, deviceId);
        return results.isEmpty() ? null : results.get(0);
    }

    @Override
    public List<ClientRegistry> findAllClients() {
        return jdbcTemplate.query(FIND_ALL_CLIENTS_SQL, clientRowMapper);
    }

    @Override
    public DeviceOwnerBinding insertBinding(DeviceOwnerBinding binding) {
        jdbcTemplate.update(INSERT_BINDING_SQL,
                binding.deviceId(),
                binding.ownerUserId(),
                binding.boundAt().toEpochMilli(),
                binding.status()
        );
        return binding;
    }

    @Override
    public DeviceOwnerBinding updateBinding(DeviceOwnerBinding binding) {
        jdbcTemplate.update(INSERT_BINDING_SQL,
                binding.deviceId(),
                binding.ownerUserId(),
                binding.boundAt().toEpochMilli(),
                binding.status()
        );
        return binding;
    }

    @Override
    public DeviceOwnerBinding findByBindingDeviceId(String deviceId) {
        List<DeviceOwnerBinding> results = jdbcTemplate.query(FIND_BINDING_BY_DEVICE_SQL, bindingRowMapper, deviceId);
        return results.isEmpty() ? null : results.get(0);
    }

    @Override
    public List<DeviceOwnerBinding> findAllBindings() {
        return jdbcTemplate.query(FIND_ALL_BINDINGS_SQL, bindingRowMapper);
    }

    @Override
    public DeviceTransferAudit insertAudit(DeviceTransferAudit audit) {
        jdbcTemplate.update(INSERT_AUDIT_SQL,
                audit.deviceId(),
                audit.fromUserId(),
                audit.toUserId(),
                audit.fromClientId(),
                audit.toClientId(),
                audit.reason(),
                audit.actor(),
                audit.createdAt().toEpochMilli()
        );
        log.info("Transfer audit inserted: deviceId={} from={} to={}", audit.deviceId(), audit.fromUserId(), audit.toUserId());
        return audit;
    }

    @Override
    public List<DeviceTransferAudit> findAuditsByDeviceId(String deviceId) {
        return jdbcTemplate.query(FIND_AUDITS_BY_DEVICE_SQL, auditRowMapper, deviceId);
    }

    @Override
    public boolean hasNonce(String nonce) {
        List<Integer> results = jdbcTemplate.query(HAS_NONCE_SQL, (rs, rowNum) -> 1, nonce);
        return !results.isEmpty();
    }

    @Override
    public void markNonce(String nonce, long expiresAt) {
        jdbcTemplate.update(MARK_NONCE_SQL, nonce, expiresAt);
    }

    @Override
    public void pruneNonce(long cutoff) {
        int deleted = jdbcTemplate.update(PRUNE_NONCE_SQL, cutoff);
        if (deleted > 0) {
            log.debug("Pruned nonces: count={}", deleted);
        }
    }

    @Override
    public int updateSessionBinding(String clientId, String instanceId, String sessionId, long lastSeenAt) {
        return jdbcTemplate.update(UPDATE_SESSION_BINDING_SQL, clientId, instanceId, sessionId, lastSeenAt);
    }

    @Override
    public int clearSessionBinding(String clientId) {
        return jdbcTemplate.update(CLEAR_SESSION_BINDING_SQL, clientId);
    }

    @Override
    public List<SessionBinding> findStaleSessionBindings(long cutoff) {
        return jdbcTemplate.query(FIND_STALE_SESSION_BINDINGS_SQL, sessionBindingRowMapper, cutoff);
    }
}
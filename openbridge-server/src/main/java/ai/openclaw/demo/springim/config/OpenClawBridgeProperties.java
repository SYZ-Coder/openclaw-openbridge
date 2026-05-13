package ai.openclaw.demo.springim.config;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Bridge service configuration.
 *
 * Contains database config, multi-instance config, and client auth config.
 */
@ConfigurationProperties(prefix = "openclaw.bridge")
public class OpenClawBridgeProperties {
    /**
     * Local persistence directory for the bridge demo.
     * Default location ensures events/replies survive service restarts.
     */
    private String storageDir = System.getProperty("user.home") + "\\.openclaw-spring-im-demo";

    /**
     * Default target client ID.
     * Used by UserChatController when clientId is not specified in request body.
     */
    private String defaultClientId = "openbridge-demo-client";

    /**
     * Registered OpenClaw client configurations.
     * Key is clientId, value is the auth info for that client.
     */
    private Map<String, Client> clients = new LinkedHashMap<>();

    /**
     * Database configuration.
     */
    private Database database = new Database();

    /**
     * Multi-instance configuration.
     */
    private Instance instance = new Instance();

    public String getDefaultClientId() {
        return defaultClientId;
    }

    public String getStorageDir() {
        return storageDir;
    }

    public void setStorageDir(String storageDir) {
        this.storageDir = storageDir;
    }

    public void setDefaultClientId(String defaultClientId) {
        this.defaultClientId = defaultClientId;
    }

    public Map<String, Client> getClients() {
        return clients;
    }

    public void setClients(Map<String, Client> clients) {
        this.clients = clients;
    }

    public Database getDatabase() {
        return database;
    }

    public void setDatabase(Database database) {
        this.database = database;
    }

    public Instance getInstance() {
        return instance;
    }

    public void setInstance(Instance instance) {
        this.instance = instance;
    }

    /**
     * Get client config by clientId; throws if not found.
     */
    public Client requireClient(String clientId) {
        Client client = clients.get(clientId);
        if (client == null) {
            throw new IllegalArgumentException("Unknown OpenClaw clientId: " + clientId);
        }
        return client;
    }

    /**
     * Database configuration for SQLite.
     */
    public static class Database {
        /**
         * SQLite database file path.
         * Default is derived from storage-dir.
         */
        private String path;

        /**
         * Maximum connection pool size.
         */
        private int maximumPoolSize = 5;

        /**
         * Minimum idle connections in pool.
         */
        private int minimumIdle = 1;

        public String getPath() {
            return path;
        }

        public void setPath(String path) {
            this.path = path;
        }

        public int getMaximumPoolSize() {
            return maximumPoolSize;
        }

        public void setMaximumPoolSize(int maximumPoolSize) {
            this.maximumPoolSize = maximumPoolSize;
        }

        public int getMinimumIdle() {
            return minimumIdle;
        }

        public void setMinimumIdle(int minimumIdle) {
            this.minimumIdle = minimumIdle;
        }
    }

    /**
     * Multi-instance coordination configuration.
     */
    public static class Instance {
        /**
         * Instance identifier for multi-instance coordination.
         * Auto-generated unique ID by default.
         */
        private String id = UUID.randomUUID().toString();

        /**
         * Session heartbeat interval in seconds.
         */
        private int heartbeatInterval = 30;

        /**
         * Session timeout in seconds.
         */
        private int sessionTimeout = 60;

        /**
         * Distributed lock timeout in seconds.
         */
        private int lockTimeout = 30;

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public int getHeartbeatInterval() {
            return heartbeatInterval;
        }

        public void setHeartbeatInterval(int heartbeatInterval) {
            this.heartbeatInterval = heartbeatInterval;
        }

        public int getSessionTimeout() {
            return sessionTimeout;
        }

        public void setSessionTimeout(int sessionTimeout) {
            this.sessionTimeout = sessionTimeout;
        }

        public int getLockTimeout() {
            return lockTimeout;
        }

        public void setLockTimeout(int lockTimeout) {
            this.lockTimeout = lockTimeout;
        }
    }

    /**
     * Individual OpenClaw client configuration.
     */
    public static class Client {
        private String token;
        private String clientSecret;

        public String getToken() {
            return token;
        }

        public void setToken(String token) {
            this.token = token;
        }

        public String getClientSecret() {
            return clientSecret;
        }

        public void setClientSecret(String clientSecret) {
            this.clientSecret = clientSecret;
        }
    }
}
package ai.openclaw.demo.springim.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.DataSourceInitializer;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

/**
 * SQLite data source configuration.
 *
 * Configures HikariCP connection pool with SQLite JDBC driver.
 * Initializes database schema from db/schema.sql on startup.
 */
@Configuration
public class DataSourceConfig {
    private static final Logger log = LoggerFactory.getLogger(DataSourceConfig.class);

    @Bean
    @Primary
    public DataSource sqliteDataSource(OpenClawBridgeProperties props) {
        String dbPath = props.getDatabase().getPath();
        if (dbPath == null || dbPath.isBlank()) {
            dbPath = props.getStorageDir() + "/openclaw.db";
        }

        // Ensure directory exists
        Path dbFile = Path.of(dbPath);
        try {
            Files.createDirectories(dbFile.getParent());
        } catch (Exception e) {
            log.warn("Failed to create database directory: {}", dbFile.getParent());
        }

        // SQLite connection string
        String jdbcUrl = "jdbc:sqlite:" + dbPath;
        log.info("SQLite database initialized: path={}", dbPath);

        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(jdbcUrl);
        config.setDriverClassName("org.sqlite.JDBC");
        config.setMaximumPoolSize(props.getDatabase().getMaximumPoolSize());
        config.setMinimumIdle(props.getDatabase().getMinimumIdle());
        config.setIdleTimeout(30000);
        config.setMaxLifetime(1800000);
        config.setConnectionTimeout(30000);

        // SQLite specific settings for better concurrency
        config.addDataSourceProperty("journal_mode", "WAL");
        config.addDataSourceProperty("synchronous", "NORMAL");
        config.addDataSourceProperty("busy_timeout", "30000");
        config.addDataSourceProperty("foreign_keys", "ON");

        return new HikariDataSource(config);
    }

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }

    @Bean
    public DataSourceInitializer dataSourceInitializer(DataSource dataSource) {
        DataSourceInitializer initializer = new DataSourceInitializer();
        initializer.setDataSource(dataSource);
        initializer.setDatabasePopulator(new ResourceDatabasePopulator(
            new ClassPathResource("db/schema.sql")
        ));
        initializer.setEnabled(true);
        return initializer;
    }
}
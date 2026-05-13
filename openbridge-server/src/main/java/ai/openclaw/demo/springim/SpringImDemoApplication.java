package ai.openclaw.demo.springim;

import ai.openclaw.demo.springim.config.OpenClawBridgeProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.data.jdbc.JdbcRepositoriesAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(exclude = {JdbcRepositoriesAutoConfiguration.class})
@EnableConfigurationProperties(OpenClawBridgeProperties.class)
@EnableScheduling
public class SpringImDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(SpringImDemoApplication.class, args);
        System.out.println("Spring IM Demo service started successfully!");
    }
}
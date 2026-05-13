package ai.openclaw.demo.springim.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * 首页转发控制器。
 *
 * <p>Spring Boot 当前 demo 主要暴露 REST 与 WebSocket 接口。为了本地联调时
 * 直接打开 http://127.0.0.1:8080/ 就能进入测试页面，这里把根路径转发到
 * static/index.html。
 */
@Controller
public class HomeController {
    @GetMapping("/")
    public String index() {
        return "forward:/index.html";
    }
}

/**
 * 插件安装/配置入口。
 *
 * OpenClaw 的 setup 流程可以导入这个文件，复用同一份 channel 插件定义，
 * 用于渲染安装与配置界面。
 */
import { openBridgePlugin } from "./src/channel.js";

console.info(
  `[${openBridgePlugin.id}] setup-entry loaded hasGateway=${Boolean(openBridgePlugin.gateway)} hasStartAccount=${Boolean(openBridgePlugin.gateway?.startAccount)}`,
);

export default { plugin: openBridgePlugin };
/**
 * OpenBridge channel plugin entry.
 *
 * Production direction:
 * - thin plugin entry
 * - service/runtime owns account lifecycle
 * - SDK owns connection, ack, reply, and callback primitives
 */
import { CHANNEL_ID, CHANNEL_LABEL } from "./src/sdk/index.js";
import { openBridgePlugin } from "./src/channel.js";
import {
  connectedClientCount,
  ensureAllAccountClientsStarted,
  startAllAccountClients,
  stopAllClients,
} from "./src/clients.js";
import { setOpenBridgePluginRuntime } from "./src/runtime-surface.js";

export default function register(api: any): void {
  setOpenBridgePluginRuntime(api?.runtime);

  api.registerChannel({ plugin: openBridgePlugin });

  api.registerService?.({
    id: `${CHANNEL_ID}-sdk`,
    start: async () => {
      if (connectedClientCount() > 0) {
        api.logger?.info?.("[openbridge] service already started");
        return;
      }
      await startAllAccountClients(api);
    },
    stop: async () => {
      await stopAllClients(api);
    },
  });

  // OpenClaw service lifecycles vary a bit across builds; trigger the same
  // managed startup path once on register so configured accounts come online
  // even if service autostart is delayed.
  ensureAllAccountClientsStarted(api, "plugin-register");

  api.logger?.info?.(`[${CHANNEL_ID}] ${CHANNEL_LABEL} channel loaded`);
}

export { openBridgePlugin };
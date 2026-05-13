type PluginRuntimeLike = {
  channel?: unknown;
};

let pluginRuntime: PluginRuntimeLike | undefined;

export function setOpenBridgePluginRuntime(runtime: unknown): void {
  if (runtime && typeof runtime === "object") {
    pluginRuntime = runtime as PluginRuntimeLike;
    return;
  }
  pluginRuntime = undefined;
}

export function getOpenBridgeChannelRuntime(): unknown {
  return pluginRuntime?.channel;
}

/**
 * 设备身份存储与签名辅助。
 *
 * 这里把"这台本地 OpenClaw 实例是谁"抽象成长期稳定的 device identity，
 * 用于 WebSocket hello、设备注册、设备移交和重绑流程。
 *
 * 设计契约：源 IP 不参与认证。
 *  - 云端 `OpenClawAuthService.verifyToken` 仅校验 clientId + token；
 *  - `DeviceServiceImpl.verifyHello` 校验 deviceId + 签名；
 *  - 因此本地 IP / NAT 出口变化都不影响重连，关键是 deviceId 与私钥
 *    必须跨重启稳定（已通过 SQLite 数据库保证）。
 *
 * 此模块现在通过 SpringImStateStore 的 SQLite 数据库进行持久化，
 * 替代原来的 JSON 文件存储。
 */
import type { SpringImStateStore, SpringImDeviceIdentity } from "./state.js";
import {
  createDeviceIdentity,
  signHello as internalSignHello,
  verifyHelloSignature as internalVerifyHelloSignature,
} from "./state.js";

/**
 * SQLite-based device identity store.
 *
 * Uses SpringImStateStore's SQLite database for persistence.
 */
export class SpringImDeviceIdentityStore {
  private identity: SpringImDeviceIdentity | undefined;
  private stateStore: SpringImStateStore;

  constructor(stateStore: SpringImStateStore) {
    this.stateStore = stateStore;
  }

  /**
   * Resolve path is now delegated to SpringImStateStore.
   * This method is kept for backwards compatibility but is deprecated.
   */
  static resolvePath(stateDir?: string): string {
    const base = stateDir?.trim() || joinPaths(process.cwd(), ".openclaw-openbridge");
    return joinPaths(base, "device.identity.json");
  }

  async load(): Promise<SpringImDeviceIdentity | undefined> {
    if (this.identity) {
      return this.identity;
    }
    this.identity = await this.stateStore.loadDeviceIdentity();
    return this.identity;
  }

  async save(identity: SpringImDeviceIdentity): Promise<void> {
    await this.stateStore.saveDeviceIdentity(identity);
    this.identity = identity;
  }

  async ensure(): Promise<SpringImDeviceIdentity> {
    if (this.identity) {
      return this.identity;
    }
    this.identity = await this.stateStore.ensureDeviceIdentity();
    return this.identity;
  }

  async updateClientBinding(input: {
    clientId: string;
    ownerUserId?: string;
  }): Promise<SpringImDeviceIdentity> {
    this.identity = await this.stateStore.updateDeviceClientBinding(input);
    return this.identity;
  }
}

/**
 * Create a new device identity with Ed25519 key pair.
 * @deprecated Use createDeviceIdentity from state.js instead.
 */
export { createDeviceIdentity };

/**
 * Build signing string for hello message.
 * @deprecated Use buildHelloSigningString from state.js instead.
 */
export function buildHelloSigningString(input: {
  deviceId: string;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    input.deviceId,
    input.clientId,
    input.accountId,
    String(input.timestamp),
    input.nonce,
  ].join(".");
}

/**
 * Sign hello message using device private key.
 * @deprecated Use signHello from state.js instead.
 */
export function signHello(input: {
  identity: SpringImDeviceIdentity;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
}): string {
  return internalSignHello(input);
}

/**
 * Verify hello signature using public key.
 * @deprecated Use verifyHelloSignature from state.js instead.
 */
export function verifyHelloSignature(input: {
  publicKeyPem: string;
  deviceId: string;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}): boolean {
  return internalVerifyHelloSignature(input);
}

function joinPaths(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/");
}
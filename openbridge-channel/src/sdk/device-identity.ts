/**
 * 设备身份存储与签名辅助。
 *
 * 这里把“这台本地 OpenClaw 实例是谁”抽象成长期稳定的 device identity，
 * 用于 WebSocket hello、设备注册、设备移交和重绑流程。
 *
 * 设计契约：源 IP 不参与认证。
 *  - 云端 `OpenClawAuthService.verifyToken` 仅校验 clientId + token；
 *  - `DeviceServiceImpl.verifyHello` 校验 deviceId + 签名；
 *  - 因此本地 IP / NAT 出口变化都不影响重连，关键是 deviceId 与私钥
 *    必须跨重启稳定（已通过 `device.identity.json` 原子写入保证）。
 */
import { randomUUID, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SpringImDeviceIdentity = {
  deviceId: string;
  installId: string;
  clientId?: string;
  ownerUserId?: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
  updatedAt: number;
};

function emptyIdentity(): never {
  throw new Error("openbridge device identity is missing or invalid");
}

function normalizeIdentity(raw: unknown): SpringImDeviceIdentity {
  if (!raw || typeof raw !== "object") {
    return emptyIdentity();
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.deviceId !== "string" ||
    typeof record.installId !== "string" ||
    typeof record.publicKeyPem !== "string" ||
    typeof record.privateKeyPem !== "string"
  ) {
    return emptyIdentity();
  }
  return {
    deviceId: record.deviceId,
    installId: record.installId,
    clientId: typeof record.clientId === "string" ? record.clientId : undefined,
    ownerUserId: typeof record.ownerUserId === "string" ? record.ownerUserId : undefined,
    publicKeyPem: record.publicKeyPem,
    privateKeyPem: record.privateKeyPem,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

export class SpringImDeviceIdentityStore {
  private identity: SpringImDeviceIdentity | undefined;

  constructor(private readonly filePath: string) {}

  static resolvePath(stateDir?: string): string {
    const base = stateDir?.trim() || join(process.cwd(), ".openclaw-openbridge");
    return join(base, "device.identity.json");
  }

  async load(): Promise<SpringImDeviceIdentity | undefined> {
    if (this.identity) {
      return this.identity;
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.identity = normalizeIdentity(JSON.parse(raw));
      return this.identity;
    } catch {
      return undefined;
    }
  }

  async save(identity: SpringImDeviceIdentity): Promise<void> {
    identity.updatedAt = Date.now();
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(identity, null, 2), "utf8");
    await rename(temp, this.filePath);
    this.identity = identity;
  }

  async ensure(): Promise<SpringImDeviceIdentity> {
    const existing = await this.load();
    if (existing) {
      return existing;
    }
    const created = createDeviceIdentity();
    await this.save(created);
    return created;
  }

  async updateClientBinding(input: {
    clientId: string;
    ownerUserId?: string;
  }): Promise<SpringImDeviceIdentity> {
    const identity = await this.ensure();
    identity.clientId = input.clientId;
    identity.ownerUserId = input.ownerUserId;
    await this.save(identity);
    return identity;
  }
}

export function createDeviceIdentity(): SpringImDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    deviceId: `dev-${randomUUID()}`,
    installId: `inst-${randomUUID()}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

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

export function signHello(input: {
  identity: SpringImDeviceIdentity;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
}): string {
  const payload = buildHelloSigningString({
    deviceId: input.identity.deviceId,
    clientId: input.clientId,
    accountId: input.accountId,
    timestamp: input.timestamp,
    nonce: input.nonce,
  });
  return sign(null, Buffer.from(payload, "utf8"), input.identity.privateKeyPem).toString("base64");
}

export function verifyHelloSignature(input: {
  publicKeyPem: string;
  deviceId: string;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}): boolean {
  const payload = buildHelloSigningString(input);
  return verify(
    null,
    Buffer.from(payload, "utf8"),
    input.publicKeyPem,
    Buffer.from(input.signature, "base64"),
  );
}

# OpenBridge SDK Refactor Record

## Status

This document is an archived implementation note. The current runtime contract is described in:

- [README](README.md)
- [openbridge-channel-design.md](openbridge-channel-design.md)
- [openbridge-communication-mechanism.md](openbridge-communication-mechanism.md)

## Current Runtime Contract

- The service owns message durability and unfinished-event recovery.
- The SDK owns connectivity, registration, heartbeats, and callback delivery.
- The plugin owns OpenClaw dispatch and WebSocket replies.
- Local plugin state is limited to short-term dedupe and runtime status.
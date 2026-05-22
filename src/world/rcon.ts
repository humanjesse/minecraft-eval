import { Rcon } from "rcon-client";
import type { Config } from "../config.js";

// Connector seam — defaults to the real rcon-client, overridable in tests.
type Connect = (opts: { host: string; port: number; password: string }) => Promise<Rcon>;

// Thin wrapper around rcon-client. Mostly here so:
//   - we can swap implementations later (e.g., a Paper plugin doing IPC)
//   - every RCON command is logged to the ground-truth exfil stream from one place
//   - reconnection / lifecycle is handled in one place
//
// Reconnection: when Paper restarts, the socket dies. We listen for 'end'/'error' to
// drop the stale connection, and `send()` lazily reconnects. We only retry a send when
// the socket is known-dead (this.rcon was cleared by an 'end'/'error') — a failure on a
// still-live socket (e.g. a command timeout) is NOT retried, so we never risk
// double-executing a non-idempotent command (give, setblock, …).
export class RconClient {
  private rcon?: Rcon;
  private connecting?: Promise<Rcon>;

  constructor(private config: Config, private connect_: Connect = (opts) => Rcon.connect(opts)) {}

  async connect(): Promise<void> {
    await this.ensure(); // eager connect at boot so config errors surface immediately
  }

  async send(command: string): Promise<string> {
    const rcon = await this.ensure();
    try {
      return await rcon.send(command);
    } catch (err) {
      // Still "connected" → the socket is live (e.g. a timeout); the command may have
      // run, so don't retry. Cleared → the socket dropped (server restart) and the
      // command didn't reach the server, so reconnect once and retry.
      if (this.rcon) throw err;
      return await (await this.ensure()).send(command);
    }
  }

  async disconnect(): Promise<void> {
    this.connecting = undefined;
    const rcon = this.rcon;
    this.rcon = undefined;
    await rcon?.end();
  }

  private ensure(): Promise<Rcon> {
    if (this.rcon) return Promise.resolve(this.rcon);
    if (!this.connecting) {
      this.connecting = this.connect_(this.config.rcon)
        .then((rcon) => {
          // A dropped connection clears the handle so the next send reconnects. The
          // listeners also keep an 'error' from crashing the process (EventEmitter
          // throws on an unhandled 'error').
          rcon.on("error", () => { this.rcon = undefined; });
          rcon.on("end", () => { this.rcon = undefined; });
          this.rcon = rcon;
          return rcon;
        })
        .finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }
}

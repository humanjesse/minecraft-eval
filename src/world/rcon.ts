import { Rcon } from "rcon-client";
import type { Config } from "../config.js";

// Thin wrapper around rcon-client. Mostly here so:
//   - we can swap implementations later (e.g., a Paper plugin doing IPC)
//   - every RCON command is logged to the ground-truth exfil stream from one place
//   - reconnection / lifecycle is handled in one place
export class RconClient {
  private rcon?: Rcon;
  constructor(private config: Config) {}

  async connect(): Promise<void> {
    this.rcon = await Rcon.connect({
      host: this.config.rcon.host,
      port: this.config.rcon.port,
      password: this.config.rcon.password,
    });
  }

  async send(command: string): Promise<string> {
    if (!this.rcon) throw new Error("rcon not connected");
    return await this.rcon.send(command);
  }

  async disconnect(): Promise<void> {
    await this.rcon?.end();
    this.rcon = undefined;
  }
}

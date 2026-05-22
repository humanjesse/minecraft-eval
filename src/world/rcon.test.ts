import type { Rcon } from "rcon-client";
import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { RconClient } from "./rcon.js";

const config = { rcon: { host: "h", port: 1, password: "p" } } as Config;

describe("RconClient reconnection", () => {
  it("reconnects once and retries after the socket drops", async () => {
    let connects = 0;
    const client = new RconClient(config, async () => {
      connects++;
      const handlers: Record<string, Array<() => void>> = {};
      const first = connects === 1;
      const rcon = {
        on: (ev: string, cb: () => void) => void (handlers[ev] ??= []).push(cb),
        end: async () => {},
        send: async (cmd: string) => {
          if (first) {
            (handlers.end ?? []).forEach((cb) => cb()); // socket drops → clears the handle
            throw new Error("socket closed");
          }
          return `ok:${cmd}`;
        },
      };
      return rcon as unknown as Rcon;
    });

    await client.connect();
    expect(await client.send("list")).toBe("ok:list");
    expect(connects).toBe(2); // reconnected exactly once
  });

  it("does not retry on a live-socket error (no double-execute)", async () => {
    let connects = 0;
    let sends = 0;
    const client = new RconClient(config, async () => {
      connects++;
      const rcon = {
        on: () => {}, // never fires 'end' → the handle stays set
        end: async () => {},
        send: async () => {
          sends++;
          throw new Error("timeout");
        },
      };
      return rcon as unknown as Rcon;
    });

    await client.connect();
    await expect(client.send("give @p diamond 64")).rejects.toThrow("timeout");
    expect(sends).toBe(1); // not retried
    expect(connects).toBe(1); // not reconnected
  });
});

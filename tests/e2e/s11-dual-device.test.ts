import { describe, expect, it } from "vitest";
import { PiRemoteApi, type DeviceCredentials } from "../../apps/mobile/src/api/client";
import { appendS11Events, createS11ServerFixture, type SessionSocket } from "./harness.js";

function deviceA(baseUrl: string): DeviceCredentials {
  return {
    baseUrl,
    deviceId: "s11-device-a",
    deviceToken: "s11-device-a-token",
    user: { id: "s11-owner", displayName: "S11 owner" }
  };
}

function eventType(message: Record<string, unknown>): string | null {
  const event = message.event;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const type = (event as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

function eventSeq(message: Record<string, unknown>): number | null {
  const event = message.event;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const seq = (event as Record<string, unknown>).seq;
  return typeof seq === "number" ? seq : null;
}

async function waitForClosed(socket: SessionSocket): Promise<number> {
  if (socket.socket.readyState === 3) return 4401;
  return new Promise<number>((resolve) => {
    socket.socket.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
}

describe("S11 two-device server contract", () => {
  it("keeps two devices on one event stream, replays after disconnect, and honors response loss and revocation", async () => {
    const fixture = await createS11ServerFixture();
    const sockets: SessionSocket[] = [];
    try {
      const credentialsA = deviceA(fixture.httpBaseUrl);
      const credentialsB = await fixture.pairDevice("S11 device B");
      const apiA = new PiRemoteApi(credentialsA, { fetchImpl: fixture.fetch });
      const apiB = new PiRemoteApi(credentialsB, { fetchImpl: fixture.fetch });

      let dropResponse = true;
      const responseLossApi = new PiRemoteApi(credentialsA, {
        fetchImpl: async (input, init) => {
          const response = await fixture.fetch(input, init);
          if (dropResponse) {
            dropResponse = false;
            throw new Error("S11 injected loss after the server committed the response");
          }
          return response;
        }
      });
      const responseLostKey = "5b3d6f43-1d70-4b7d-9d53-0b0bd7f6a011";
      const responseLostRequest = () => responseLossApi.createSession(
        fixture.projectId,
        { title: "created once despite lost response" },
        responseLostKey
      );
      await expect(responseLostRequest()).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
      const responseLost = await responseLostRequest();
      expect(responseLost.session.title).toBe("created once despite lost response");
      const commandCount = fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM commands WHERE client_command_id = ?"
      ).get(responseLostKey) as { count: number | bigint };
      expect(Number(commandCount.count)).toBe(1);

      const socketA = await fixture.connectSessionSocket(credentialsA.deviceToken, 0);
      const socketB = await fixture.connectSessionSocket(credentialsB.deviceToken, 0);
      sockets.push(socketA, socketB);

      const target = (await apiA.listSessions(fixture.projectId, "all")).items.find((item) => item.id === fixture.sessionId);
      if (!target) throw new Error("S11 target Session was not listed");
      const renameResults = await Promise.allSettled([
        apiA.patchSession(
          fixture.sessionId,
          { expectedVersion: target.version, title: "由设备 A 修改" },
          "8c61a76e-6b71-4e52-9e31-96fb282a4b01"
        ),
        apiB.patchSession(
          fixture.sessionId,
          { expectedVersion: target.version, title: "由设备 B 修改" },
          "d2df7da5-b7a5-4a24-b57f-3ee9cdcd3f48"
        )
      ]);
      expect(renameResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const conflict = renameResults.find((result) => result.status === "rejected");
      expect(conflict?.status === "rejected" ? conflict.reason : null).toMatchObject({ code: "VERSION_CONFLICT" });

      await Promise.all([
        socketA.waitFor((message) => eventType(message) === "session.updated"),
        socketB.waitFor((message) => eventType(message) === "session.updated")
      ]);
      const firstNotice = appendS11Events(fixture, [{
        type: "runtime.notice",
        payload: { kind: "generic", message: "两台设备都应观察到这条记录" }
      }]);
      const [noticeA, noticeB] = await Promise.all([
        socketA.waitFor((message) => eventType(message) === "runtime.notice"),
        socketB.waitFor((message) => eventType(message) === "runtime.notice")
      ]);
      expect([eventSeq(noticeA), eventSeq(noticeB)]).toEqual([firstNotice.lastSeq, firstNotice.lastSeq]);

      // Close A before the next committed event. Rejoining from the last
      // durable cursor must replay the missing event instead of re-running a
      // command.
      await socketA.close();
      const replayNotice = appendS11Events(fixture, [{
        type: "runtime.notice",
        payload: { kind: "generic", message: "断线期间提交" }
      }]);
      await socketB.waitFor((message) => eventType(message) === "runtime.notice" && eventSeq(message) === replayNotice.lastSeq);
      const reconnectedA = await fixture.connectSessionSocket(credentialsA.deviceToken, firstNotice.lastSeq);
      sockets.push(reconnectedA);
      await expect(reconnectedA.waitFor((message) => eventType(message) === "runtime.notice" && eventSeq(message) === replayNotice.lastSeq))
        .resolves.toBeTruthy();

      const revokedClose = waitForClosed(socketB);
      const revokeResponse = await fixture.app.inject({
        method: "DELETE",
        url: `/v1/devices/${credentialsB.deviceId}`,
        headers: {
          authorization: `Bearer ${credentialsA.deviceToken}`,
          "idempotency-key": "f3a51cc9-8e45-4a2d-9a83-7f6eaf19c620"
        }
      });
      expect(revokeResponse.statusCode).toBe(200);
      await expect(revokedClose).resolves.toBe(4401);
      await expect(apiB.getMe()).rejects.toMatchObject({ code: "DEVICE_REVOKED", status: 401 });
      await expect(apiA.getMe()).resolves.toMatchObject({ user: { id: "s11-owner" } });
    } finally {
      for (const socket of sockets) await socket.close();
      await fixture.close();
    }
  }, 20_000);
});

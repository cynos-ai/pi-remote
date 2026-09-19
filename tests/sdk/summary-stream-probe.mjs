import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

// Test-only relay. No payloads, headers or credentials are retained. After the
// first nonempty content frame it holds further delivery until client abort,
// giving both SDK and HTTP controllers the same deterministic network window.
export async function summaryStreamProbe(agentDir, provider) {
  const path = join(agentDir, "models.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  const selected = config.providers[provider];
  assert.ok(selected?.baseUrl, "summary probe requires a configured provider base URL");
  assert.ok(!selected.models?.some(model => model.baseUrl), "model-specific base URLs require a separate probe");
  const base = new URL(selected.baseUrl.replace(/\/$/, "") + "/");
  assert.ok(["http:", "https:"].includes(base.protocol));
  const controllers = new Set();
  let armed;
  const server = createServer(async (req, res) => {
    const probe = armed;
    armed = undefined;
    const controller = new globalThis.AbortController();
    controllers.add(controller);
    res.on("close", () => {
      controller.abort();
      if (probe?.observed) probe.closed();
    });
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/chat/completions");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers["content-length"];
      const response = await fetch(new URL("chat/completions", base), {
        method: "POST", headers, body: Buffer.concat(chunks),
        signal: controller.signal, redirect: "error"
      });
      assert.equal(response.status, 200, "summary probe upstream did not return success");
      res.writeHead(200, { "content-type": response.headers.get("content-type") || "text/event-stream" });
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body) {
        if (!probe) { res.write(chunk); continue; }
        buffered = (buffered + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
        let boundary;
        while ((boundary = buffered.indexOf("\n\n")) >= 0) {
          const frame = buffered.slice(0, boundary + 2);
          buffered = buffered.slice(boundary + 2);
          res.write(frame);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          if (data && data !== "[DONE]") {
            const parsed = JSON.parse(data);
            if (parsed.choices?.some(choice => typeof choice.delta?.content === "string" && choice.delta.content.length && !choice.finish_reason)) {
              probe.observed = true;
              probe.ready();
              await new Promise(resolve => {
                if (controller.signal.aborted) resolve();
                else controller.signal.addEventListener("abort", resolve, { once: true });
              });
              return;
            }
          }
        }
      }
      if (probe) throw new Error("summary ended without a cancellable content frame");
      res.end();
    } catch {
      if (!controller.signal.aborted) {
        probe?.fail(new Error("summary stream probe failed before cancellation"));
        res.destroy();
      }
    } finally { controller.abort(); controllers.delete(controller); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  selected.baseUrl = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path, JSON.stringify(config));
  return {
    arm() {
      assert.equal(armed, undefined);
      let ready, fail, closed;
      const firstContent = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
      void firstContent.catch(() => {});
      const cancelled = new Promise(resolve => { closed = resolve; });
      armed = { ready, fail, closed, observed: false };
      return { firstContent, cancelled };
    },
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

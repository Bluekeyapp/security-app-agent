import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("offline cache includes the exact versioned startup modules", async () => {
  const [html, app, worker] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../sw.js", import.meta.url), "utf8")
  ]);
  const stylesheet = html.match(/href="(\.\/styles\/app\.css\?v=\d+)"/)?.[1];
  const entry = html.match(/src="(\.\/src\/app\.js\?v=\d+)"/)?.[1];
  const storage = app.match(/from "(\.\/storage\.js\?v=\d+)"/)?.[1];
  assert.ok(stylesheet && entry && storage);
  for (const asset of [stylesheet, entry, `./src/${storage.slice(2)}`]) {
    assert.ok(worker.includes(JSON.stringify(asset)), `${asset} must be pre-cached`);
  }
  const imports = [...app.matchAll(/from "(\.\/[^"\n]+\.js(?:\?v=\d+)?)"/g)].map((match) => `./src/${match[1].slice(2)}`);
  for (const asset of imports) assert.ok(worker.includes(JSON.stringify(asset)), `${asset} must be pre-cached`);
});

test("startup failure shows a retry panel instead of a blank view", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const startupScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(startupScript);

  function showsFallback(appReady) {
    let timeout;
    let shown = false;
    const fallback = { removeAttribute: (name) => { if (name === "hidden") shown = true; } };
    runInNewContext(startupScript, {
      window: { setTimeout: (callback) => { timeout = callback; } },
      document: {
        documentElement: { dataset: { appReady } },
        getElementById: (id) => id === "startupFallback" ? fallback : { addEventListener: () => {} }
      },
      location: { reload: () => {} }
    });
    timeout();
    return shown;
  }

  assert.equal(showsFallback(undefined), true);
  assert.equal(showsFallback("true"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("login client distinguishes lockout, rejection and network failures", async () => {
  let response;
  let request;
  globalThis.__loginFeedbackClient = { async rpc(name, args) { request = {name, args}; return response; } };
  try {
    const source = (await readFile(new URL("../src/agentRemoteStore.js", import.meta.url), "utf8"))
      .replace('import { getSupabaseClient } from "./supabaseClient.js";',
        'const getSupabaseClient = async () => globalThis.__loginFeedbackClient;');
    const { authenticateAgent } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    response = {data:{ok:false,reason:"locked",retry_after_seconds:61}};
    assert.deepEqual(await authenticateAgent({badge:" A1 ",pin:"123456",remember:true}),
      {ok:false,locked:true,retryAfterSeconds:61});
    assert.deepEqual(request, {name:"agent_login",args:{p_badge:"A1",p_pin:"123456",p_remember:true}});
    response = {data:{ok:false,reason:"locked",retry_after_seconds:"bad"}};
    assert.equal((await authenticateAgent({})).retryAfterSeconds, null);
    response = {data:{ok:false,reason:"invalid_credentials"}};
    assert.deepEqual(await authenticateAgent({}), {ok:false,invalidCredentials:true});
    const error = {code:"PGRST202",message:"RPC unavailable"};
    response = {data:null,error};
    assert.deepEqual(await authenticateAgent({}), {ok:false,error});
    response = {data:{ok:true,agent:{id:"a",badge:"A1",name:"Agent",site_id:"site",site_name:"Site",session_epoch:"epoch",token:"token"}}};
    assert.equal((await authenticateAgent({remember:true})).token, "token");
    const normal = await authenticateAgent({});
    assert.equal(normal.token, null);
    assert.equal(normal.sessionEpoch, "epoch");
    assert.equal(normal.agent.siteId, "site");
  } finally {
    delete globalThis.__loginFeedbackClient;
  }
});

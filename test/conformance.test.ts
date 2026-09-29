import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { checkFacilitator } from "../src/checks/facilitator.js";
import { checkServer } from "../src/checks/server.js";
import { startReferenceServer, type Break } from "../src/fixtures/reference-server.js";
import type { Report } from "../src/types.js";

const status = (rep: Report, id: string) => rep.results.find(r => r.id === id)?.status;
const failing = (rep: Report) => rep.results.filter(r => r.status === "fail").map(r => r.id);

for (const version of [2, 1] as const) {
  describe(`clean reference server (v${version})`, () => {
    let srv: Awaited<ReturnType<typeof startReferenceServer>>;
    before(async () => { srv = await startReferenceServer({ version }); });
    after(() => srv.close());

    it("resource server: zero failures", async () => {
      const rep = await checkServer({ url: `${srv.url}/paid`, samples: 2 });
      assert.deepEqual(failing(rep), [], JSON.stringify(rep.results.filter(r => r.status !== "pass"), null, 2));
      assert.equal(rep.x402Version, version);
      assert.equal(status(rep, "S14"), "pass");
    });

    it("facilitator: zero failures", async () => {
      const rep = await checkFacilitator({ url: `${srv.url}/facilitator` });
      assert.deepEqual(failing(rep), [], JSON.stringify(rep.results.filter(r => r.status !== "pass"), null, 2));
      assert.equal(status(rep, "F04"), "pass");
      assert.equal(status(rep, "F05"), "pass");
    });
  });
}

/** Each injected fault and the check(s) that must catch it. */
const serverFaults: Array<[Break, string[], (1 | 2)[]]> = [
  ["no-402", ["S01"], [1, 2]],
  ["leak", ["S14"], [1, 2]],
  ["bad-base64", ["S02"], [2]],
  ["wrong-version", ["S03"], [1, 2]],
  ["empty-accepts", ["S04"], [1, 2]],
  ["missing-fields", ["S05"], [1, 2]],
  ["float-amount", ["S06"], [1, 2]],
  ["zero-amount", ["S06"], [1, 2]],
  ["bad-network", ["S07"], [1, 2]],
  ["bad-payto", ["S08"], [1, 2]],
  ["no-extra", ["S17"], [1, 2]],
  ["crash-on-garbage", ["S12"], [1, 2]],
];

const serverWarnFaults: Array<[Break, string, (1 | 2)[]]> = [
  ["wrong-usdc", "S09b", [1, 2]],
  ["huge-timeout", "S10b", [1, 2]],
  ["text-content-type", "S16", [1, 2]],
  ["wrong-resource", "S11", [1, 2]],
  ["reject-400", "S14b", [1, 2]],
  ["no-header", "S02", [2]], // passes with a note; make sure it does NOT fail
];

for (const [brk, ids, versions] of serverFaults) {
  for (const version of versions) {
    describe(`fault "${brk}" (v${version})`, () => {
      let srv: Awaited<ReturnType<typeof startReferenceServer>>;
      before(async () => { srv = await startReferenceServer({ version, breaks: [brk] }); });
      after(() => srv.close());
      it(`is caught by ${ids.join("+")}`, async () => {
        const rep = await checkServer({ url: `${srv.url}/paid`, samples: 1 });
        for (const id of ids) assert.equal(status(rep, id), "fail", `${id} should fail: ${JSON.stringify(rep.results.find(r => r.id === id))}`);
      });
    });
  }
}

for (const [brk, id, versions] of serverWarnFaults) {
  for (const version of versions) {
    describe(`soft fault "${brk}" (v${version})`, () => {
      let srv: Awaited<ReturnType<typeof startReferenceServer>>;
      before(async () => { srv = await startReferenceServer({ version, breaks: [brk] }); });
      after(() => srv.close());
      it(`${id} warns (or passes) but nothing hard-fails`, async () => {
        const rep = await checkServer({ url: `${srv.url}/paid`, samples: 1 });
        const s = status(rep, id);
        assert.ok(s === "warn" || (brk === "no-header" && s === "pass"), `${id} = ${s}`);
        if (brk !== "no-header") assert.equal(s, "warn");
        assert.deepEqual(failing(rep), []);
      });
    });
  }
}

const facilitatorFaults: Array<[Break, string]> = [
  ["fac-verify-200-on-garbage", "F03"],
  ["fac-verify-accepts-forged", "F04"],
  ["fac-settle-500", "F05"],
  ["fac-settle-txhash-on-fail", "F05b"],
  ["fac-bad-kinds", "F02"],
];

for (const [brk, id] of facilitatorFaults) {
  describe(`facilitator fault "${brk}"`, () => {
    let srv: Awaited<ReturnType<typeof startReferenceServer>>;
    before(async () => { srv = await startReferenceServer({ breaks: [brk] }); });
    after(() => srv.close());
    it(`is caught by ${id}`, async () => {
      const rep = await checkFacilitator({ url: `${srv.url}/facilitator` });
      assert.equal(status(rep, id), "fail", JSON.stringify(rep.results.find(r => r.id === id)));
    });
  });
}

describe(`facilitator soft fault "fac-no-invalid-reason"`, () => {
  let srv: Awaited<ReturnType<typeof startReferenceServer>>;
  before(async () => { srv = await startReferenceServer({ breaks: ["fac-no-invalid-reason"] }); });
  after(() => srv.close());
  it("F04b warns", async () => {
    const rep = await checkFacilitator({ url: `${srv.url}/facilitator` });
    assert.equal(status(rep, "F04b"), "warn");
  });
});

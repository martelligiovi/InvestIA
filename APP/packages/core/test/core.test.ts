import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionDeniedError,
  executeSeedBox,
  isSafePublicHttpUrl,
  isScannerFinding,
  urlSeed,
  type EmailSeed,
  type RegistrationObservation,
  type SeedBox,
  type ExecutionState,
} from "../src/index.ts";

test("URL seeds accept public HTTP URLs, normalize them and remove fragments", () => {
  const longest = "https://example.org/".padEnd(2048, "a");
  for (const value of [longest, "http://example.org", "https://example.org./path?q=one%20two", "https://8.8.8.8", "https://[2606:4700::1111]/"]) {
    assert.equal(isSafePublicHttpUrl(value), true, value);
  }
  assert.deepEqual(urlSeed("  HTTPS://LinkedIn.com:443/in/example?view=public#bio  "), {
    kind: "url", value: "https://linkedin.com/in/example?view=public",
  });
});

test("URL seed validation rejects nonpublic hosts and malformed or ambiguous URLs", () => {
  assert.equal(isSafePublicHttpUrl(undefined), false);
  assert.equal(isSafePublicHttpUrl(" https://example.org/ "), false, "only the constructor trims input");
  const invalid = [
    "", "example.org", "ftp://example.org", "https:example.org", "https://", "https://.",
    "https://u@example.org", "https://:p@example.org", "https://u:p@example.org",
    "https://example.org/white space", "https://exa\tmple.org", "https://example.org/\u0000x", "https://example.org/\u007f",
    "https://example.org/".padEnd(2049, "a"),
    ...[
      "localhost", "sub.localhost.", "host.local", "host.internal.", "home.arpa", "host.home.arpa", "singlelabel",
      "0.1.2.3", "10.255.255.255", "100.64.0.0", "100.127.255.255", "127.0.0.1", "2130706433", "0x7f.1",
      "169.254.1.2", "172.16.0.0", "172.31.255.255", "192.168.1.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
      "[::]", "[::1]", "[fc00::1]", "[fdff::1]", "[fe80::1]", "[febf::1]", "[ff01::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]",
    ].map((host) => `https://${host}/`),
  ];
  for (const value of invalid) {
    assert.equal(isSafePublicHttpUrl(value), false, JSON.stringify(value));
    assert.throws(() => urlSeed(value), { message: "A valid public HTTP URL seed is required" }, JSON.stringify(value));
  }
  for (const host of ["100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0"]) {
    assert.equal(isSafePublicHttpUrl(`http://${host}/`), true, host);
  }
});

test("scanner findings require a safe URL when the target kind is URL", () => {
  const finding = {
    target: { kind: "url", value: "https://example.org/page" }, upstreamStatus: "Found",
    url: "https://example.org/page", category: "Page", reason: "", extra: {}, media: {},
  };
  assert.equal(isScannerFinding(finding), true);
  assert.equal(isScannerFinding({ ...finding, target: { kind: "url", value: "http://127.0.0.1/" } }), false);
  assert.equal(isScannerFinding({ ...finding, target: { kind: ["url"], value: "http://127.0.0.1/" } }), false);
});

const seed: EmailSeed = { kind: "email", value: "person@example.org" };
const observation: RegistrationObservation = {
  kind: "registration",
  seed,
  provider: "github",
  status: "registered",
};

function makeBox(onExecute: () => void): SeedBox<EmailSeed, RegistrationObservation> {
  return {
    id: "test-box",
    inputKind: "email",
    async execute() {
      onExecute();
      return [observation];
    },
  };
}

test("requires explicit authorization before invoking a box", async () => {
  let invoked = false;
  await assert.rejects(
    executeSeedBox(makeBox(() => { invoked = true; }), seed, {
      authorized: false,
      approved: true,
      paused: false,
    }),
    (error: unknown) => error instanceof ExecutionDeniedError && error.code === "unauthorized",
  );
  assert.equal(invoked, false);
});

test("requires approval before invoking a box", async () => {
  let invoked = false;
  await assert.rejects(
    executeSeedBox(makeBox(() => { invoked = true; }), seed, {
      authorized: true,
      approved: false,
      paused: false,
    }),
    (error: unknown) => error instanceof ExecutionDeniedError && error.code === "unapproved",
  );
  assert.equal(invoked, false);
});

test("a paused execution cannot invoke a box", async () => {
  let invoked = false;
  await assert.rejects(
    executeSeedBox(makeBox(() => { invoked = true; }), seed, {
      authorized: true,
      approved: true,
      paused: true,
    }),
    (error: unknown) => error instanceof ExecutionDeniedError && error.code === "paused",
  );
  assert.equal(invoked, false);
});

test("fails closed when authorization, approval, or unpaused state is not explicit", async () => {
  const invalidStates = [
    [{ authorized: true, approved: true, paused: undefined }, "paused"],
    [{ authorized: "yes", approved: true, paused: false }, "unauthorized"],
    [{ authorized: true, approved: 1, paused: false }, "unapproved"],
  ] as const;

  for (const [state, code] of invalidStates) {
    let invoked = false;
    await assert.rejects(
      executeSeedBox(makeBox(() => { invoked = true; }), seed, state as unknown as ExecutionState),
      (error: unknown) => error instanceof ExecutionDeniedError && error.code === code,
    );
    assert.equal(invoked, false);
  }
});

test("executes and returns observations only when all gates are clear", async () => {
  let invoked = false;
  const result = await executeSeedBox(makeBox(() => { invoked = true; }), seed, {
    authorized: true,
    approved: true,
    paused: false,
  });
  assert.equal(invoked, true);
  assert.deepEqual(result, [observation]);
});

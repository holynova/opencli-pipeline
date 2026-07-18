import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(".");
const bin = join(root, "bin", "ocp.js");
const fixture = join(root, "test", "fixtures", "opencli.js");

function ocp(args, cwd = root) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENCLI_BIN: fixture }
  });
}

test("providers exposes only discovered text and image generation capabilities", () => {
  const result = ocp(["providers", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    text: ["deepseek", "gemini"],
    image: ["chatgpt", "gemini"]
  });
});

test("help provides an executable workflow and command-specific guidance", () => {
  const overview = ocp(["help"]);
  assert.equal(overview.status, 0, overview.stderr);
  assert.match(overview.stdout, /v0\.1\.0/);
  assert.match(overview.stdout, /github\.com\/holynova\/opencli-pipeline/);
  assert.match(overview.stdout, /推荐流程/);
  assert.match(overview.stdout, /ocp preflight/);
  const runHelp = ocp(["help", "run"]);
  assert.equal(runHelp.status, 0, runHelp.stderr);
  assert.match(runHelp.stdout, /运行 Pipeline/);
  assert.match(runHelp.stdout, /--out/);
});

test("preflight reports every selected provider without requiring a generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocp-preflight-"));
  const pipeline = join(directory, "pipeline.json");
  await writeFile(pipeline, JSON.stringify({ version: 1, name: "preflight", mode: "text", providers: ["gemini", "deepseek"], prompts: [{ id: "one", text: "hello" }] }));
  const result = ocp(["preflight", pipeline, "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).providers.map(({ id, login }) => ({ id, login })), [
    { id: "gemini", login: "yes" },
    { id: "deepseek", login: "no" }
  ]);
});

test("run saves each text result in prompt then provider order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocp-run-"));
  const pipeline = join(directory, "pipeline.json");
  const out = join(directory, "runs");
  await writeFile(pipeline, JSON.stringify({ version: 1, name: "serial", mode: "text", providers: ["gemini"], prompts: [{ id: "first", text: "第一条" }, { id: "second", text: "第二条" }], options: { allowUnknownLogin: false } }));
  const result = ocp(["run", pipeline, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const runDirectory = result.stdout.trim();
  const manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.items.map((item) => item.id), ["001-first--gemini", "002-second--gemini"]);
  assert.equal(await readFile(join(runDirectory, "items", "001-first--gemini", "response.md"), "utf8"), "fixture:第一条\n");
});

test("image run requires a downloaded file and saves it under the item directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocp-image-"));
  const pipeline = join(directory, "pipeline.json");
  const out = join(directory, "runs");
  await writeFile(pipeline, JSON.stringify({ version: 1, name: "image", mode: "image", providers: ["gemini"], prompts: [{ id: "cover", text: "cover" }] }));
  const result = ocp(["run", pipeline, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const resultFile = JSON.parse(await readFile(join(result.stdout.trim(), "items", "001-cover--gemini", "result.json"), "utf8"));
  assert.equal(resultFile.files.length, 1);
  assert.match(resultFile.files[0], /images\/fixture\.png$/);
});

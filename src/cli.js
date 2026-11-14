import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import packageJson from "../package.json" with { type: "json" };

const IMAGE_PROVIDERS = new Set(["chatgpt", "gemini"]);
const DEFAULT_TEXT_PROVIDERS = new Set(["chatgpt", "gemini", "claude", "deepseek", "doubao", "grok", "kimi", "qwen", "yuanbao"]);
const DEFAULT_TIMEOUTS = { image: 240, text: 120 };

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || ["--help", "-h"].includes(command)) return printHelp();
  if (command === "help") return printHelp(rest[0]);
  if (command === "providers") return providersCommand(rest);
  if (command === "preflight") return preflightCommand(rest);
  if (command === "login") return loginCommand(rest);
  if (command === "validate") return validateCommand(rest);
  if (command === "run") return runCommand(rest);
  if (command === "resume") return resumeCommand(rest);
  if (command === "init") return initCommand(rest);
  throw new Error(`未知命令：${command}。请运行 ocp help 查看可用命令。`);
}

function printHelp(topic) {
  const guides = {
    init: `创建 Pipeline\n\n用法：ocp init [--mode text|image --providers a,b --prompts-file prompts.txt --out pipeline.json]\n\n不带参数时会依次询问模式、平台和多条提示词。也可用 --prompts-file 读取每行一条的提示词。创建后先运行 ocp validate pipeline.json。`,
    providers: `查看当前机器支持的平台\n\n用法：ocp providers [--json]\n\n读取 opencli list -f json，显示可用于文本的 ask 适配器与可用于图像的 ChatGPT、Gemini。--json 适合脚本处理。`,
    preflight: `检查环境和账号，不生成内容\n\n用法：ocp preflight <pipeline.json> [--json] [--login]\n\n检查 OpenCLI Browser Bridge、平台能力和登录状态。--login 会对尚未登录的平台打开网页登录页并等待完成登录。状态为 no 或 unknown 时，run 默认拒绝执行。`,
    login: `登录所选平台\n\n用法：ocp login <pipeline.json>\n\n跳过已登录的平台，依次打开其余平台的官方登录页。登录完成后会再次预检。此命令不发送任何提示词。`,
    validate: `校验 Pipeline 配置\n\n用法：ocp validate <pipeline.json>\n\n检查模式、平台、提示词 ID 和 provider options 是否与当前 OpenCLI 能力相容，不会连接模型或生成内容。未安装 OpenCLI 时只做离线结构校验，并明确提示哪些项未校验。`,
    run: `运行 Pipeline\n\n用法：ocp run <pipeline.json> [--out runs]\n\n先执行预检，随后按提示词顺序和平台顺序串行调用 OpenCLI。默认输出到 runs/<时间>-<名称>/。--out 可指定输出根目录。发生失败时是否继续由 options.continueOnError 控制。`,
    resume: `恢复未完成的运行\n\n用法：ocp resume <run-directory>\n\n重新预检账号，只重试 failed 或 pending 项。已成功且产物仍在的项不会再次生成。`
  };
  if (topic) {
    if (!guides[topic]) throw new Error(`没有这个帮助主题：${topic}。请运行 ocp help 查看可用主题。`);
    stdout.write(`${guides[topic]}\n`);
    return;
  }
  stdout.write(`OpenCLI Pipeline (ocp) v${packageJson.version}\n仓库：${packageJson.homepage}\n\n把一批提示词按顺序提交到 OpenCLI 支持的网页模型，并把每一次文本或图片结果保存到本地。\n\n推荐流程\n  1. ocp providers                         查看本机可用平台\n  2. ocp init --out pipeline.json          创建配置，也可手工编辑 JSON\n  3. ocp validate pipeline.json            检查配置\n  4. ocp preflight pipeline.json           检查 Browser Bridge 与账号\n  5. ocp login pipeline.json               完成未登录账户的网页登录\n  6. ocp run pipeline.json                 串行生成并保存结果\n  7. ocp resume <run-directory>            仅重试失败项\n\n命令\n  init        创建 Pipeline 配置\n  providers   查看动态发现的平台\n  preflight   无生成预检，也可加 --login\n  login       引导未登录平台完成网页登录\n  validate    校验配置，不生成内容\n  run         运行 Pipeline，可加 --out <目录>\n  resume      恢复未完成的运行\n\n常用帮助\n  ocp help run\n  ocp help preflight\n  ocp help init\n\n关键规则\n  - text 模式可选择一个或多个 OpenCLI ask 平台。providers: ["all"] 只展开通用网页文本平台。\n  - image 模式仅支持 chatgpt 与 gemini。\n  - 全局等待时间使用 options.timeoutSeconds；单个平台覆盖使用 providers[].timeoutSeconds。\n  - 模型、深度思考、比例、风格等写在 providers[].options，必须是 OpenCLI 公开支持的参数。\n  - run 前会预检登录状态，不会绕过登录、验证码或账号权限。\n`);
}

function hasFlag(args, flag) { return args.includes(flag); }
function option(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

async function providersCommand(args) {
  const data = await discoverCapabilities();
  const value = { text: data.text.map((item) => item.site).sort(), image: data.image.map((item) => item.site).sort() };
  stdout.write(hasFlag(args, "--json") ? `${JSON.stringify(value)}\n` : `文本：${value.text.join(", ") || "无"}\n图像：${value.image.join(", ") || "无"}\n`);
}

async function validateCommand(args) {
  const file = requireArgument(args[0], "pipeline.json");
  const pipeline = await loadPipeline(file);
  try {
    await validatePipeline(pipeline, await discoverCapabilities());
  } catch (error) {
    if (error.code !== "OPENCLI_NOT_FOUND") throw error;
    validatePipelineOffline(pipeline);
    stdout.write(`有效（离线校验：未找到 opencli，只检查了配置结构与图像模式平台限制，文本平台可用性与平台参数未校验）：${resolve(file)}\n`);
    return;
  }
  stdout.write(`有效：${resolve(file)}\n`);
}

async function preflightCommand(args) {
  const file = requireArgument(args[0], "pipeline.json");
  const pipeline = await loadPipeline(file);
  const report = await preflight(pipeline, { login: hasFlag(args, "--login") });
  if (hasFlag(args, "--json")) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printPreflight(report);
  if (!report.ready) process.exitCode = 2;
}

async function loginCommand(args) {
  const file = requireArgument(args[0], "pipeline.json");
  const pipeline = await loadPipeline(file);
  const report = await preflight(pipeline, { login: true });
  printPreflight(report, stderrWriter);
  if (!report.ready) process.exitCode = 2;
}

async function runCommand(args) {
  const file = requireArgument(args[0], "pipeline.json");
  const base = option(args, "--out", "runs");
  const pipeline = await loadPipeline(file);
  const report = await preflight(pipeline);
  printPreflight(report, stderrWriter);
  if (!report.ready) {
    process.exitCode = 2;
    return;
  }
  const runDirectory = join(resolve(base), `${timestamp()}-${slug(pipeline.name)}`);
  await executeRun(pipeline, report.capabilities, runDirectory);
  stdout.write(`${runDirectory}\n`);
}

async function resumeCommand(args) {
  const runDirectory = resolve(requireArgument(args[0], "run-directory"));
  let pipeline;
  try {
    pipeline = JSON.parse(await readFile(join(runDirectory, "pipeline.resolved.json"), "utf8"));
  } catch {
    throw new Error(`运行目录里找不到 pipeline.resolved.json：${runDirectory}。请确认路径是某次 ocp run 的输出目录。`);
  }
  const report = await preflight(pipeline);
  printPreflight(report, stderrWriter);
  if (!report.ready) {
    process.exitCode = 2;
    return;
  }
  await executeRun(pipeline, report.capabilities, runDirectory, { resume: true });
  stdout.write(`${runDirectory}\n`);
}

async function initCommand(args) {
  const mode = option(args, "--mode", null);
  const providerText = option(args, "--providers", null);
  const promptFile = option(args, "--prompts-file", null);
  const out = resolve(option(args, "--out", "pipeline.json"));
  let values = { mode, providers: providerText?.split(",").filter(Boolean), prompts: null };
  if (!values.mode || !values.providers) {
    const ui = createInterface({ input: stdin, output: stdout });
    values.mode ||= (await ui.question("模式（text/image）：")).trim();
    values.providers ||= (await ui.question("平台（英文逗号分隔）：")).split(",").map((value) => value.trim()).filter(Boolean);
    values.prompts = [];
    while (true) {
      const text = (await ui.question(`提示词 ${values.prompts.length + 1}（空行结束）：`)).trim();
      if (!text) break;
      values.prompts.push(text);
    }
    ui.close();
  }
  if (promptFile) values.prompts = (await readFile(resolve(promptFile), "utf8")).split(/\r?\n/).filter(Boolean);
  values.prompts ||= [];
  if (!["text", "image"].includes(values.mode)) throw new Error(`模式必须是 text 或 image，当前是：${values.mode ?? "（未填）"}。`);
  if (!values.providers?.length) throw new Error("至少要选一个平台，例如 --providers gemini,deepseek。");
  if (values.prompts.length === 0) throw new Error("提示词为空：请用 --prompts-file 指定提示词文件，或不带参数运行 ocp init 交互输入。");
  const pipeline = { version: 1, name: basename(out, extname(out)), mode: values.mode, providers: values.providers, prompts: values.prompts.map((text, index) => ({ id: `prompt-${String(index + 1).padStart(3, "0")}`, text })), options: { timeoutSeconds: DEFAULT_TIMEOUTS[values.mode] || 120, continueOnError: true, siteSession: "ephemeral" } };
  await writeJson(out, pipeline);
  stdout.write(`${out}\n`);
}

async function preflight(pipeline, { login = false } = {}) {
  const doctor = await invokeOpencli(["doctor"]);
  const capabilities = await discoverCapabilities();
  await validatePipeline(pipeline, capabilities);
  const selected = resolveProviders(pipeline, capabilities);
  const providers = [];
  for (const provider of selected) {
    let status = await invokeOpencli([provider.id, "status", "-f", "json"]);
    let value = parseOutput(status.stdout);
    let state = loginState(value, status);
    let loginError = "";
    if (login && state !== "yes") {
      process.stdout.write(`正在打开 ${provider.id} 登录页；请在浏览器完成登录…\n`);
      const loginResult = await invokeOpencli([provider.id, "login", "--timeout", "300", "--window", "foreground"]);
      if (loginResult.code !== 0) loginError = loginResult.stderr || loginResult.stdout;
      status = await invokeOpencli([provider.id, "status", "-f", "json"]);
      value = parseOutput(status.stdout);
      state = loginState(value, status);
    }
    providers.push({ id: provider.id, login: state, status: value, error: status.code === 0 ? loginError : status.stderr || status.stdout });
  }
  const allowed = new Set([...(pipeline.options?.allowGuest || []), ...(pipeline.options?.allowUnknownLogin || [])]);
  const ready = doctor.code === 0 && providers.every((provider) => provider.login === "yes" || allowed.has(provider.id));
  return { ready, doctor: { ok: doctor.code === 0, output: doctor.stdout.trim() }, capabilities, providers };
}

const stderrWriter = { write: (value) => process.stderr.write(value) };
function printPreflight(report, output = stdout) {
  output.write(`OpenCLI：${report.doctor.ok ? "正常" : "不可用"}\n`);
  for (const provider of report.providers) output.write(`${provider.id}：${provider.login}${provider.error ? `（${provider.error.trim()}）` : ""}\n`);
  output.write(report.ready ? "预检通过。\n" : "预检未通过：请登录标为“no/unknown”的平台，或在 pipeline options 中明确放行访客/未知状态。\n");
}

async function executeRun(pipeline, capabilities, runDirectory, { resume = false } = {}) {
  const providers = resolveProviders(pipeline, capabilities);
  await mkdir(join(runDirectory, "items"), { recursive: true });
  if (!resume) {
    await writeJson(join(runDirectory, "pipeline.resolved.json"), pipeline);
    await writeFile(join(runDirectory, "prompts.jsonl"), pipeline.prompts.map((prompt) => JSON.stringify(prompt)).join("\n") + "\n");
  }
  const manifestPath = join(runDirectory, "manifest.json");
  const manifest = resume ? JSON.parse(await readFile(manifestPath, "utf8")) : { version: 1, startedAt: new Date().toISOString(), opencliVersion: await opencliVersion(), items: [] };
  let count = 0;
  for (const prompt of pipeline.prompts) for (const provider of providers) {
    count += 1;
    const id = `${String(count).padStart(3, "0")}-${slug(prompt.id)}--${slug(provider.id)}`;
    const existing = manifest.items.find((item) => item.id === id);
    if (resume && existing?.status === "succeeded" && await exists(join(runDirectory, "items", id, pipeline.mode === "image" ? "images" : "response.md"))) continue;
    const item = await executeItem({ pipeline, prompt, provider, capability: findCapability(capabilities, provider.id, pipeline.mode === "image" ? "image" : "text"), runDirectory, id });
    const index = manifest.items.findIndex((entry) => entry.id === id);
    if (index >= 0) manifest.items[index] = item; else manifest.items.push(item);
    await writeJson(manifestPath, manifest);
    if (item.status !== "succeeded" && pipeline.options?.continueOnError === false) break;
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.status = manifest.items.some((item) => item.status !== "succeeded") ? "completed_with_failures" : "succeeded";
  await writeJson(manifestPath, manifest);
  await writeSummary(runDirectory, manifest);
  if (manifest.status !== "succeeded") process.exitCode = 2;
}

async function executeItem({ pipeline, prompt, provider, capability, runDirectory, id }) {
  const directory = join(runDirectory, "items", id);
  const startedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  const timeout = provider.timeoutSeconds || pipeline.options?.timeoutSeconds || DEFAULT_TIMEOUTS[pipeline.mode];
  const args = [provider.id, pipeline.mode === "image" ? "image" : "ask", prompt.text];
  const supported = new Set((capability.args || []).map((argument) => argument.name));
  if (pipeline.mode === "image") {
    const imageDirectory = join(directory, "images");
    await mkdir(imageDirectory, { recursive: true });
    args.push("--op", imageDirectory);
  }
  if (supported.has("timeout")) args.push("--timeout", String(timeout));
  for (const [key, value] of Object.entries(provider.options || {})) {
    if (!supported.has(key)) throw new Error(`${provider.id} 不支持该平台参数：${key}。请运行 opencli ${provider.id} ${pipeline.mode === "image" ? "image" : "ask"} --help 查看可用参数。`);
    args.push(`--${key}`, String(value));
  }
  args.push("-f", "json", "--site-session", pipeline.options?.siteSession || "ephemeral");
  await writeJson(join(directory, "request.json"), { provider: provider.id, prompt, args, startedAt });
  const output = await invokeOpencli(args);
  await writeFile(join(directory, "stderr.log"), output.stderr);
  const parsed = parseOutput(output.stdout);
  await writeJson(join(directory, "stdout.json"), parsed ?? { raw: output.stdout });
  const files = pipeline.mode === "image" ? await filesIn(join(directory, "images")) : [];
  const text = pipeline.mode === "text" ? extractText(parsed) : "";
  const succeeded = output.code === 0 && (pipeline.mode === "image" ? files.length > 0 : Boolean(text));
  if (pipeline.mode === "text" && text) await writeFile(join(directory, "response.md"), `${text.trim()}\n`);
  const result = { id, status: succeeded ? "succeeded" : "failed", provider: provider.id, promptId: prompt.id, startedAt, finishedAt: new Date().toISOString(), exitCode: output.code, response: text, files, error: succeeded ? "" : output.stderr || "OpenCLI 没有返回结果" };
  await writeJson(join(directory, "result.json"), result);
  return result;
}

function opencliNotFoundError() {
  const error = new Error("找不到 opencli 命令。请先安装 OpenCLI，并确认它在 PATH 里（可运行 opencli --version 检查）；也可设置 OPENCLI_BIN 指向 opencli 可执行文件。");
  error.code = "OPENCLI_NOT_FOUND";
  return error;
}

async function discoverCapabilities() {
  const result = await invokeOpencli(["list", "-f", "json"]);
  if (result.spawnError === "ENOENT") throw opencliNotFoundError();
  if (result.code !== 0) throw new Error(`读取 OpenCLI 平台列表失败：${(result.stderr || result.stdout).trim() || `退出码 ${result.code}`}。请运行 opencli doctor 检查 OpenCLI 状态。`);
  const commands = parseOutput(result.stdout);
  if (!Array.isArray(commands)) throw new Error("opencli list 没有返回 JSON 数组，请运行 opencli doctor 检查 OpenCLI 状态。");
  const text = commands.filter((item) => item.name === "ask" && item.browser && item.access === "write");
  const image = commands.filter((item) => item.name === "image" && IMAGE_PROVIDERS.has(item.site) && item.access === "write");
  return { text, image };
}

function resolveProviders(pipeline, capabilities) {
  const raw = pipeline.providers.flatMap((provider) => provider === "all" ? capabilities.text.filter((item) => DEFAULT_TEXT_PROVIDERS.has(item.site)).map((item) => item.site) : [provider]);
  return raw.map((provider) => typeof provider === "string" ? { id: provider, options: {} } : { id: provider.id, timeoutSeconds: provider.timeoutSeconds, options: provider.options || {} });
}

function validateStructure(pipeline) {
  if (!pipeline || pipeline.version !== 1) throw new Error("配置 version 必须是 1。");
  if (!["text", "image"].includes(pipeline.mode)) throw new Error("配置 mode 必须是 text 或 image。");
  if (!Array.isArray(pipeline.providers) || pipeline.providers.length === 0) throw new Error("配置 providers 不能为空。");
  if (!Array.isArray(pipeline.prompts) || pipeline.prompts.length === 0) throw new Error("配置 prompts 不能为空。");
  const ids = new Set();
  for (const prompt of pipeline.prompts) {
    if (!prompt?.id || !prompt?.text?.trim()) throw new Error("每条提示词都需要非空的 id 和 text。");
    if (ids.has(prompt.id)) throw new Error(`提示词 id 重复：${prompt.id}`);
    ids.add(prompt.id);
  }
}

async function validatePipeline(pipeline, capabilities) {
  validateStructure(pipeline);
  for (const provider of resolveProviders(pipeline, capabilities)) {
    if (!provider.id) throw new Error("每个平台对象都需要 id。");
    const capability = findCapability(capabilities, provider.id, pipeline.mode);
    if (!capability) throw new Error(`${provider.id} 在这台机器上不是可用的${pipeline.mode === "image" ? "图像" : "文本"}平台。请运行 ocp providers 查看可用平台。`);
    const known = new Set((capability.args || []).map((argument) => argument.name));
    for (const key of Object.keys(provider.options || {})) if (!known.has(key)) throw new Error(`${provider.id} 不支持该平台参数：${key}。请运行 opencli ${provider.id} ${pipeline.mode === "image" ? "image" : "ask"} --help 查看可用参数。`);
  }
}

function validatePipelineOffline(pipeline) {
  validateStructure(pipeline);
  if (pipeline.mode === "image") {
    const providers = pipeline.providers.flatMap((provider) => provider === "all" ? [] : [typeof provider === "string" ? provider : provider.id]);
    for (const id of providers) {
      if (!IMAGE_PROVIDERS.has(id)) throw new Error(`图像模式只支持 chatgpt 和 gemini，当前是：${id}。`);
    }
  }
}

function findCapability(capabilities, provider, mode) { return (mode === "image" ? capabilities.image : capabilities.text).find((item) => item.site === provider); }
async function loadPipeline(file) {
  let text;
  try {
    text = await readFile(resolve(file), "utf8");
  } catch {
    throw new Error(`找不到配置文件：${resolve(file)}。请确认路径正确。`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`配置文件不是有效的 JSON：${resolve(file)}（${error.message}）。请检查 JSON 格式，例如多余的逗号或未闭合的括号。`);
  }
}
function requireArgument(value, name) { if (!value || value.startsWith("--")) throw new Error(`缺少必填参数：${name}。`); return value; }
function parseOutput(text) { try { return JSON.parse(text); } catch { return text.trim() || null; } }
function loginState(value, result) { const source = `${typeof value === "string" ? value : JSON.stringify(value)} ${result.stderr}`.toLowerCase(); if (result.code !== 0) return "unknown"; if (/login[^a-z]*(yes|true)|logged_in[^a-z]*(true|yes)/.test(source)) return "yes"; if (/guest|login[^a-z]*(no|false)|not_logged_in/.test(source)) return "no"; return "unknown"; }
function extractText(value) { if (typeof value === "string") return value; if (!value || typeof value !== "object") return ""; for (const key of ["response", "text", "Text", "content", "message", "answer"]) if (typeof value[key] === "string" && value[key].trim()) return value[key]; for (const item of Object.values(value)) { const found = extractText(item); if (found) return found; } return ""; }
function slug(value) { return String(value).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "item"; }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, ""); }
async function exists(path) { try { await access(path, constants.F_OK); return true; } catch { return false; } }
async function filesIn(directory) { if (!await exists(directory)) return []; const entries = await readdir(directory, { withFileTypes: true }); return entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name)); }
async function writeJson(file, value) { await mkdir(dirname(file), { recursive: true }); const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }
async function writeSummary(directory, manifest) { const lines = [`# OpenCLI Pipeline Run`, "", `状态：${manifest.status}`, "", "| 项目 | 平台 | 状态 | 文件 |", "| --- | --- | --- | --- |"]; for (const item of manifest.items) lines.push(`| ${item.promptId} | ${item.provider} | ${item.status} | ${item.files.join("<br>") || (item.response ? `items/${item.id}/response.md` : "-")} |`); await writeFile(join(directory, "summary.md"), `${lines.join("\n")}\n`); }
async function opencliVersion() { const result = await invokeOpencli(["--version"]); return result.stdout.trim() || "unknown"; }
async function invokeOpencli(args) { const binary = process.env.OPENCLI_BIN || "opencli"; const command = binary.endsWith(".js") ? process.execPath : binary; const commandArgs = binary.endsWith(".js") ? [binary, ...args] : args; return new Promise((resolvePromise) => { const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] }); let stdoutText = ""; let stderrText = ""; child.stdout.on("data", (chunk) => { stdoutText += chunk; }); child.stderr.on("data", (chunk) => { stderrText += chunk; }); child.on("error", (error) => resolvePromise({ code: 69, stdout: stdoutText, stderr: `${stderrText}${error.message}`, spawnError: error.code })); child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout: stdoutText, stderr: stderrText })); }); }

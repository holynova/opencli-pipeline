#!/usr/bin/env node
const args = process.argv.slice(2);

const commands = [
  { command: "gemini/ask", site: "gemini", name: "ask", access: "write", browser: true, description: "Send a prompt to Gemini", args: [{ name: "prompt", positional: true, required: true }, { name: "timeout", type: "int" }] },
  { command: "deepseek/ask", site: "deepseek", name: "ask", access: "write", browser: true, description: "Send a prompt to DeepSeek", args: [{ name: "prompt", positional: true, required: true }, { name: "model", choices: ["instant", "expert"] }] },
  { command: "chatgpt/image", site: "chatgpt", name: "image", access: "write", browser: true, description: "Generate images", args: [{ name: "prompt", positional: true, required: true }, { name: "op" }] },
  { command: "gemini/image", site: "gemini", name: "image", access: "write", browser: true, description: "Generate images", args: [{ name: "prompt", positional: true, required: true }, { name: "op" }] }
];

if (args[0] === "list") {
  process.stdout.write(JSON.stringify(commands));
  process.exit(0);
}

if (args[0] === "doctor") {
  process.stdout.write("Everything looks good!\n");
  process.exit(0);
}

if (args[1] === "status") {
  const status = args[0] === "deepseek" ? { Status: "Connected", Login: "No" } : { Status: "Connected", Login: "Yes" };
  process.stdout.write(JSON.stringify(status));
  process.exit(0);
}

if (args[1] === "ask") {
  process.stdout.write(JSON.stringify({ response: `fixture:${args[2]}` }));
  process.exit(0);
}

if (args[1] === "image") {
  const target = args[args.indexOf("--op") + 1];
  await (await import("node:fs/promises")).mkdir(target, { recursive: true });
  await (await import("node:fs/promises")).writeFile(`${target}/fixture.png`, "image");
  process.stdout.write(JSON.stringify({ status: "success", file: `${target}/fixture.png` }));
  process.exit(0);
}

process.stderr.write(`unsupported fixture call: ${args.join(" ")}`);
process.exit(64);

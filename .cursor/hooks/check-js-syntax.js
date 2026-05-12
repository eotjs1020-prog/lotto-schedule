"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");

function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return;
  }
  if (!String(raw).trim()) {
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const filePath = data.file_path;
  if (typeof filePath !== "string" || !filePath.toLowerCase().endsWith(".js")) {
    return;
  }

  const r = spawnSync(process.execPath, ["--check", filePath], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim() || `Syntax error in ${filePath}`;
    process.stderr.write(`[check-js-syntax] ${msg}\n`);
  }
}

main();

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
for (const dir of ["server", "runner", "public", "scripts"])
  for (const file of readdirSync(dir))
    if (/\.(mjs|js)$/.test(file))
      execFileSync(process.execPath, ["--check", `${dir}/${file}`], {
        stdio: "inherit",
      });
console.log("JavaScript syntax checks passed");

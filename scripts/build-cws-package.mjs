import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const zipPath = path.join(distDir, "air-visual-cws.zip");

await rm(zipPath, { force: true });
await mkdir(distDir, { recursive: true });
const stagingDir = await mkdtemp(path.join(os.tmpdir(), "air-visual-cws-"));

try {
  await cp(rootDir, stagingDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(rootDir, source);
      if (!relative) {
        return true;
      }

      const basename = path.basename(source);
      if (basename === ".DS_Store") {
        return false;
      }

      if (relative === "dist" || relative.startsWith(`dist${path.sep}`)) {
        return false;
      }

      if (relative === "server" || relative.startsWith(`server${path.sep}`)) {
        return false;
      }

      if (relative === "store-assets" || relative.startsWith(`store-assets${path.sep}`)) {
        return false;
      }

      if (relative === "docs" || relative.startsWith(`docs${path.sep}`)) {
        return false;
      }

      if (relative === "scripts" || relative.startsWith(`scripts${path.sep}`)) {
        return false;
      }

      return true;
    }
  });

  const manifest = JSON.parse(await readFile(path.join(rootDir, "manifest.json"), "utf8"));
  await writeFile(path.join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (!existsSync(path.join(stagingDir, "icons", "icon-128.png"))) {
    throw new Error("Missing root icons. Expected icons/icon-128.png");
  }

  await zipDirectory(stagingDir, zipPath);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}

console.log(`CWS zip created at ${zipPath}`);

async function zipDirectory(sourceDir, destinationZip) {
  await new Promise((resolve, reject) => {
    const zip = spawn("zip", ["-r", destinationZip, "."], {
      cwd: sourceDir,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    zip.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    zip.on("error", reject);
    zip.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `zip exited with code ${code}`));
    });
  });
}

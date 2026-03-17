import { existsSync } from "fs";
import { join } from "path";

export async function deployGhPages(siteDir: string, message = "deploy: update wiki"): Promise<void> {
  if (!existsSync(siteDir)) {
    throw new Error(`Build directory not found: ${siteDir}. Run 'kiwimu build' first.`);
  }

  const ghPages = await import("gh-pages");
  return new Promise((resolve, reject) => {
    ghPages.publish(
      siteDir,
      {
        message,
        dotfiles: false,
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export async function deployVercel(siteDir: string): Promise<void> {
  const proc = Bun.spawn(["vercel", "--prod", siteDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error("Vercel deploy failed");
}

import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build verzija za detekciju zastarelog klijenta (src/components/update-notifier.tsx).
 * JEDAN izvor, dva odredišta:
 *   • env NEXT_PUBLIC_BUILD_ID → zapečena u JS bundle = verzija koju je klijent UČITAO
 *   • public/version.json      → statika na origin-u  = verzija koja je DEPLOYOVANA
 * Klijent ih periodično poredi i traži refresh kad se razlikuju. Računa se ovde jer se
 * config učitava pre SVAKOG build-a, ma kako pozvan: `npm run build`, `npm run deploy`
 * (Cloudflare) i backend CI bake (docker node-slim BEZ git binarija → .git čitamo ručno).
 */
function resolveBuildVersion(): string {
  try {
    const git = (cmd: string) =>
      execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const sha = git("git rev-parse --short=10 HEAD");
    if (sha) {
      // Lokalni deploy sa nekomitovanim izmenama mora dati DRUGU verziju od čistog
      // build-a istog commita — sufiks je hash diff-a (stabilan između procesa,
      // menja se tek kad se sadržaj promeni).
      const dirty = git("git status --porcelain");
      if (!dirty) return sha;
      const diff = execSync("git diff HEAD", {
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      }).toString();
      const suffix = createHash("sha1").update(dirty).update(diff).digest("hex").slice(0, 8);
      return `${sha}-l${suffix}`;
    }
  } catch {
    /* nema git binarija → probaj .git direktno */
  }
  try {
    const gitDir = join(process.cwd(), ".git");
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 10); // detached HEAD = goli SHA
    const ref = head.slice(4).trim();
    const refFile = join(gitDir, ref);
    if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 10);
    const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      if (line.endsWith(` ${ref}`)) return line.slice(0, 10);
    }
  } catch {
    /* ni .git nije dostupan */
  }
  return `t${Date.now().toString(36)}`;
}

const buildVersion = resolveBuildVersion();
const builtAt = new Date().toISOString();
writeFileSync(
  join(process.cwd(), "public", "version.json"),
  JSON.stringify({ version: buildVersion, builtAt }),
);

/**
 * Static export → Cloudflare Pages.
 * App je 100% client-side (localStorage token + TanStack Query), nema SSR-a,
 * pa `output: "export"` daje čist statički `out/` (bez Workers runtime-a/adaptera).
 * API URL se bake-uje u build iz NEXT_PUBLIC_API_URL (vidi .env.production).
 */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: false,
  env: {
    NEXT_PUBLIC_BUILD_ID: buildVersion,
    NEXT_PUBLIC_BUILD_AT: builtAt,
  },
};

export default nextConfig;

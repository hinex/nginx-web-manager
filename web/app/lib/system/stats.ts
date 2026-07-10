import { readFileSync } from "fs";
import { execSync } from "child_process";
import os from "os";

export interface SystemStats {
  cpu: { usage: number; cores: number };
  memory: { used: number; total: number };
  disk: { used: number; total: number; path: string };
  load: number[];
  uptime: number;
  nginx: {
    active: number;
    reading: number;
    writing: number;
    waiting: number;
    requests: number;
    accepted: number;
    handled: number;
  } | null;
  network: { bytesIn: number; bytesOut: number } | null;
}

let prevCpuIdle = 0;
let prevCpuTotal = 0;

export function getSystemStats(): SystemStats {
  return {
    cpu: getCpu(),
    memory: getMemory(),
    disk: getDisk(),
    load: os.loadavg(),
    uptime: os.uptime(),
    nginx: getNginxStatus(),
    network: getNetwork(),
  };
}

function getCpu(): { usage: number; cores: number } {
  const cores = os.cpus().length;
  try {
    const stat = readFileSync("/proc/stat", "utf-8");
    const line = stat.split("\n")[0]; // "cpu  user nice system idle ..."
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3];
    const total = parts.reduce((a, b) => a + b, 0);

    const diffIdle = idle - prevCpuIdle;
    const diffTotal = total - prevCpuTotal;
    prevCpuIdle = idle;
    prevCpuTotal = total;

    const usage = diffTotal > 0 ? ((1 - diffIdle / diffTotal) * 100) : 0;
    return { usage: Math.round(usage * 10) / 10, cores };
  } catch {
    return { usage: 0, cores };
  }
}

function getMemory(): { used: number; total: number } {
  const total = os.totalmem();
  const free = os.freemem();
  return { used: total - free, total };
}

function getDisk(): { used: number; total: number; path: string } {
  try {
    const output = execSync("df -B1 / | tail -1", { encoding: "utf-8", timeout: 3000 });
    const parts = output.trim().split(/\s+/);
    return {
      total: parseInt(parts[1]) || 0,
      used: parseInt(parts[2]) || 0,
      path: "/",
    };
  } catch {
    return { used: 0, total: 0, path: "/" };
  }
}

function getNginxStatus(): SystemStats["nginx"] {
  try {
    const res = execSync(
      "curl -s http://127.0.0.1:51820/nginx_status 2>/dev/null || curl -s http://127.0.0.1:80/nginx_status 2>/dev/null",
      { encoding: "utf-8", timeout: 2000 }
    );
    // A missing stub_status endpoint returns an HTML error page — not zeros
    if (!res.includes("Active connections:")) return null;
    const active = parseInt(res.match(/Active connections:\s*(\d+)/)?.[1] || "0");
    const counts = res.match(/\s(\d+)\s+(\d+)\s+(\d+)\s*\n/);
    const accepted = parseInt(counts?.[1] || "0");
    const handled = parseInt(counts?.[2] || "0");
    const requests = parseInt(counts?.[3] || "0");
    const rw = res.match(/Reading:\s*(\d+)\s+Writing:\s*(\d+)\s+Waiting:\s*(\d+)/);
    return {
      active,
      reading: parseInt(rw?.[1] || "0"),
      writing: parseInt(rw?.[2] || "0"),
      waiting: parseInt(rw?.[3] || "0"),
      requests,
      accepted,
      handled,
    };
  } catch {
    return null;
  }
}

let prevNetRx = 0;
let prevNetTx = 0;

function getNetwork(): { bytesIn: number; bytesOut: number } | null {
  try {
    const data = readFileSync("/proc/net/dev", "utf-8");
    const lines = data.split("\n").filter((l) => l.includes(":") && !l.includes("lo:"));
    let totalRx = 0;
    let totalTx = 0;
    for (const line of lines) {
      const parts = line.split(":")[1]?.trim().split(/\s+/);
      if (parts) {
        totalRx += parseInt(parts[0]) || 0;
        totalTx += parseInt(parts[8]) || 0;
      }
    }
    const bytesIn = prevNetRx > 0 ? totalRx - prevNetRx : 0;
    const bytesOut = prevNetTx > 0 ? totalTx - prevNetTx : 0;
    prevNetRx = totalRx;
    prevNetTx = totalTx;
    return { bytesIn: Math.max(0, bytesIn), bytesOut: Math.max(0, bytesOut) };
  } catch {
    return null;
  }
}

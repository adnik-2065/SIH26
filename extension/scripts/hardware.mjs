import os from 'node:os';
import { statfsSync } from 'node:fs';
const disk = statfsSync('.');
console.log(JSON.stringify({
  recordedAt: new Date().toISOString(), os: `${os.platform()} ${os.release()}`, arch: os.arch(),
  cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length,
  ramGiB: +(os.totalmem() / 2 ** 30).toFixed(2), availableDiskGiB: +(disk.bavail * disk.bsize / 2 ** 30).toFixed(2),
  node: process.version, gpu: 'Record using browser/OS profiler', vram: 'Record manually where available',
}, null, 2));

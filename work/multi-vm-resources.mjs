import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { stat } from 'node:fs/promises';
import { ShellVM } from '../outputs/v86-shell-server/dist/vm.js';

const image = new URL('../outputs/v86-shell-server/images/linux/', import.meta.url).pathname;
const memoryMiB = Number(process.argv[2] || 256);
const count = Number(process.argv[3] || 2);
const vms = [];
const snapshot = label => {
  global.gc?.();
  console.log(JSON.stringify({label, memory: process.memoryUsage(), wasmMemoryBytes: vms.map(vm => vm.emulator.v86.cpu.wasm_memory.buffer.byteLength)}));
};
const idle = async label => {
  const started = performance.now(), cpu = process.cpuUsage();
  await delay(3000);
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  console.log(JSON.stringify({label, elapsedMs, cpuMicroseconds: used, oneCorePercent: (used.user + used.system) / elapsedMs / 10}));
};
console.log(JSON.stringify({host:{arch: process.arch,node:process.version,physicalRamBytes:os.totalmem(),cpuCount:os.cpus().length},memoryMiB,count,imageFiles: await Promise.all(['bzimage','initrd.img','seabios.bin','vgabios.bin'].map(async name => ({name,bytes:(await stat(image+name)).size})))}));
snapshot('baseline');
try {
  for (let index=0; index<count; index++) {
    const started=performance.now();
    vms.push(await ShellVM.boot({image,memoryMiB,mounts:[],bootTimeoutMs:30000}));
    console.log(JSON.stringify({label:`boot_${index+1}`,elapsedMs:performance.now()-started}));
    snapshot(`after_boot_${index+1}`);
    console.log(JSON.stringify({label:`guest_${index+1}`,result:await vms[index].execute({command:"cat /proc/meminfo; printf '%s\\n' marker-"+(index+1)+" > /tmp/resource-isolation-marker; cat /tmp/resource-isolation-marker", timeoutMs:5000})}));
    await idle(`idle_${index+1}_vms`);
    snapshot(`after_idle_${index+1}`);
  }
  if(vms.length > 1) console.log(JSON.stringify({label:'concurrent_isolation_check',results:await Promise.all(vms.map(vm=>vm.execute({command:'cat /tmp/resource-isolation-marker',timeoutMs:5000})))}));
  snapshot('before_destroy');
} finally {
  await Promise.allSettled(vms.map(vm=>vm.destroy()));
  snapshot('after_destroy');
}

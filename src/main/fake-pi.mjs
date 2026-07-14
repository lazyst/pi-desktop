// src/main/fake-pi.mjs
// Stand-in for `pi` in automated E2E: prints a heartbeat every second,
// echoes stdin lines, and exits cleanly on SIGTERM. No network / model / credentials.
let n = 0;
const timer = setInterval(() => { n += 1; process.stdout.write(`tick ${n}\n`); }, 1000);
process.stdout.write('fake-pi ready\n');

process.stdin.on('data', (d) => {
  const s = d.toString();
  process.stdout.write(`echo: ${s}`);
});

function shutdown() {
  clearInterval(timer);
  process.stdout.write('terminated\n');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });

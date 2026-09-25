import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createXperExtension } from "../../adapters/pi/dist/extension.js";

const localBinary = fileURLToPath(new URL("../../target/debug/xper", import.meta.url));

export default function xperExtension(pi: Parameters<typeof createXperExtension>[0]): void {
  createXperExtension(pi, {
    command: process.env.XPER_BRIDGE_COMMAND ?? (existsSync(localBinary) ? localBinary : "xper"),
  });
}

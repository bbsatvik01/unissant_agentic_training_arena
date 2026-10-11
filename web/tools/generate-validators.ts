/** Write the compiled wire validators (see validators-codegen.ts): `pnpm gen:validators`. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateValidators } from "./validators-codegen.ts";

const target = fileURLToPath(new URL("../src/lib/contracts/compiled/", import.meta.url));
const { js, dts } = generateValidators();
writeFileSync(`${target}validators.js`, js);
writeFileSync(`${target}validators.d.ts`, dts);

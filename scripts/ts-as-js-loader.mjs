/**
 * Resolve bare .js imports to sibling .ts sources for node --test +
 * --experimental-strip-types (imports use .js extension per ESM convention).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      typeof specifier === "string" &&
      specifier.endsWith(".js") &&
      !specifier.startsWith("node:") &&
      context.parentURL
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const abs = path.resolve(parentDir, specifier);
      const asTs = abs.replace(/\.js$/, ".ts");
      if (existsSync(asTs)) {
        return nextResolve(pathToFileURL(asTs).href, context);
      }
    }
    throw error;
  }
}

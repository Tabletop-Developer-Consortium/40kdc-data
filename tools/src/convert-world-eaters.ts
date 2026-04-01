/**
 * Converts World Eaters data from army-assist format to 40kdc-data format.
 *
 * Thin wrapper around the generic converter.
 * Usage: npx tsx tools/src/convert-world-eaters.ts
 */

import { convertFaction } from "./convert-faction.js";
import worldEatersConfig from "./converters/configs/world-eaters.js";

// Register all configs (side-effect imports in convert-faction handle this,
// but we import directly here to be explicit about the dependency)
import "./converters/configs/emperors-children.js";

convertFaction(worldEatersConfig);

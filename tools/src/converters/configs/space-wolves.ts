import { registerFaction, type FactionConfig } from "../faction-config.js";

const spaceWolves: FactionConfig = {
  sourceFactionId: "SM",
  factionId: "space-wolves",
  factionName: "Space Wolves",
  factionAbilityName: "Oath of Moment",
  factionRuleId: "oath-of-moment",
  factionKeywords: ["Imperium", "Adeptus Astartes", "Space Wolves"],
  parentFactionId: "adeptus-astartes",
  aliases: [],
  compositionOverrides: {},
  skipUnits: true,
  detachmentFilter: ["Champions of Fenris", "Saga of the Beastslayer", "Saga of the Bold", "Saga of the Great Wolf", "Saga of the Hunter"],
};

registerFaction(spaceWolves);

export default spaceWolves;

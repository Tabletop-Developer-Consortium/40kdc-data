export const GAME_DATACARDS_BASE =
  "https://raw.githubusercontent.com/game-datacards/datasources/main/10th/json";

export const GAME_DATACARDS_IDENTITY_BASE =
  "https://raw.githubusercontent.com/game-datacards/datasources/main/11th/gdc";

/** Repository faction id → exact game-datacards source file basenames. */
export const GAME_DATACARDS_FACTION_FILES: Readonly<
  Record<string, readonly string[]>
> = {
  "adepta-sororitas": ["adeptasororitas"],
  "adeptus-astartes": [
    "space_marines",
    "blacktemplar",
    "bloodangels",
    "darkangels",
    "deathwatch",
    "spacewolves",
    "marines_leviathan",
  ],
  "adeptus-custodes": ["adeptuscustodes"],
  "adeptus-mechanicus": ["adeptusmechanicus"],
  aeldari: ["aeldari"],
  "agents-of-the-imperium": ["agents"],
  "astra-militarum": ["astramilitarum"],
  "chaos-daemons": ["chaosdaemons"],
  "chaos-knights": ["chaosknights"],
  "chaos-space-marines": ["chaos_spacemarines"],
  "death-guard": ["deathguard"],
  drukhari: ["drukhari"],
  "emperors-children": ["emperors_children"],
  "genestealer-cults": ["gsc"],
  "grey-knights": ["greyknights"],
  "imperial-knights": ["imperialknights"],
  "leagues-of-votann": ["votann"],
  necrons: ["necrons"],
  orks: ["orks"],
  "tau-empire": ["tau"],
  "thousand-sons": ["thousandsons"],
  tyranids: ["tyranids"],
  "world-eaters": ["worldeaters"],
  "black-templars": ["blacktemplar", "space_marines"],
  "blood-angels": ["bloodangels", "space_marines"],
  "dark-angels": ["darkangels", "space_marines"],
  deathwatch: ["deathwatch", "space_marines"],
  "space-wolves": ["spacewolves", "space_marines"],
  "crimson-fists": ["space_marines"],
  "imperial-fists": ["space_marines"],
  "iron-hands": ["space_marines"],
  "raven-guard": ["space_marines"],
  salamanders: ["space_marines"],
  ultramarines: ["space_marines"],
  "white-scars": ["space_marines"],
};

/** Curated top-level source records that identify a canonical faction exactly. */
export const GAME_DATACARDS_FACTION_IDENTITY_FILES: Readonly<
  Partial<Record<string, string>>
> = {
  "adepta-sororitas": "adeptasororitas",
  "adeptus-astartes": "space_marines",
  "adeptus-custodes": "adeptuscustodes",
  "adeptus-mechanicus": "adeptusmechanicus",
  aeldari: "aeldari",
  "agents-of-the-imperium": "agents",
  "astra-militarum": "astramilitarum",
  "chaos-daemons": "chaosdaemons",
  "chaos-knights": "chaosknights",
  "chaos-space-marines": "chaos_spacemarines",
  "death-guard": "deathguard",
  drukhari: "drukhari",
  "emperors-children": "emperors_children",
  "genestealer-cults": "gsc",
  "grey-knights": "greyknights",
  "imperial-knights": "imperialknights",
  "leagues-of-votann": "votann",
  necrons: "necrons",
  orks: "orks",
  "tau-empire": "tau",
  "thousand-sons": "thousandsons",
  tyranids: "tyranids",
  "world-eaters": "worldeaters",
  "black-templars": "blacktemplar",
  "blood-angels": "bloodangels",
  "dark-angels": "darkangels",
  deathwatch: "deathwatch",
  "space-wolves": "spacewolves",
};

export const GAME_DATACARDS_GLOBAL_FILES = ["core", "enhancements"] as const;

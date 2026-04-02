import { registerFaction, type FactionConfig } from "../faction-config.js";

const adeptaSororitas: FactionConfig = {
  sourceFactionId: "AS",
  factionId: "adepta-sororitas",
  factionName: "Adepta Sororitas",
  factionAbilityName: "Acts of Faith",
  factionRuleId: "acts-of-faith",
  factionKeywords: ["Imperium", "Adepta Sororitas"],
  parentFactionId: null,
  aliases: [],
  compositionOverrides: {
    "battle-sisters-squad": [
      { name: "Sister Superior", profile_name: "Battle Sister", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-weapon"], is_leader_model: true },
      { name: "Battle Sister", min: 9, max: 9, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "celestian-sacresants": [
      { name: "Sacresant Superior", profile_name: "Celestian Sacresant", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "hallowed-mace"], is_leader_model: true },
      { name: "Celestian Sacresant", min: 4, max: 9, default_weapon_ids: ["bolt-pistol", "hallowed-mace"], is_leader_model: false },
    ],
    "celestian-insidiants": [
      { name: "Insidiant Superior", profile_name: "Celestian Insidiant", min: 1, max: 1, default_weapon_ids: ["condemnor-bolt-pistol", "blessed-sword"], is_leader_model: true },
      { name: "Celestian Insidiant", min: 9, max: 9, default_weapon_ids: ["condemnor-bolt-pistol", "null-mace"], is_leader_model: false },
    ],
    "dominion-squad": [
      { name: "Dominion Superior", profile_name: "Dominion", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-weapon"], is_leader_model: true },
      { name: "Dominion", min: 9, max: 9, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "seraphim-squad": [
      { name: "Seraphim Superior", profile_name: "Seraphim", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "chainsword"], is_leader_model: true },
      { name: "Seraphim", min: 4, max: 9, default_weapon_ids: ["bolt-pistol", "close-combat-weapon"], is_leader_model: false },
    ],
    "zephyrim-squad": [
      { name: "Zephyrim Superior", profile_name: "Zephyrim", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-weapon"], is_leader_model: true },
      { name: "Zephyrim", min: 4, max: 9, default_weapon_ids: ["bolt-pistol", "power-weapon"], is_leader_model: false },
    ],
    "retributor-squad": [
      { name: "Retributor Superior", profile_name: "Retributor", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-weapon"], is_leader_model: true },
      { name: "Retributor", min: 4, max: 4, default_weapon_ids: ["boltgun", "close-combat-weapon"], is_leader_model: false },
    ],
    "repentia-squad": [
      { name: "Repentia Superior", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "neural-whips"], is_leader_model: true },
      { name: "Sister Repentia", min: 4, max: 9, default_weapon_ids: ["penitent-eviscerator"], is_leader_model: false },
    ],
    "sisters-novitiate-squad": [
      { name: "Novitiate Superior", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "power-weapon"], is_leader_model: true },
      { name: "Sister Novitiate", min: 9, max: 9, default_weapon_ids: ["autogun", "close-combat-weapon"], is_leader_model: false },
    ],
    "sanctifiers": [
      { name: "Missionary", profile_name: "Missionary", min: 1, max: 1, default_weapon_ids: ["holy-fire", "close-combat-weapon"], is_leader_model: true },
      { name: "Miraculist", min: 2, max: 2, default_weapon_ids: ["ministorum-hand-flamer", "close-combat-weapon"], is_leader_model: false },
      { name: "Salvationist", min: 2, max: 2, default_weapon_ids: ["ministorum-flamer", "close-combat-weapon"], is_leader_model: false },
      { name: "Death Cult Assassin", min: 2, max: 2, default_weapon_ids: ["death-cult-blades"], is_leader_model: false },
      { name: "Sanctifier", min: 2, max: 2, default_weapon_ids: ["sanctifier-melee-weapon"], is_leader_model: false },
    ],
    "saint-celestine": [
      { name: "Celestine", min: 1, max: 1, default_weapon_ids: ["the-ardent-blade-strike"], is_leader_model: true },
      { name: "Geminae Superia", min: 2, max: 2, default_weapon_ids: ["bolt-pistol", "power-weapon"], is_leader_model: false },
    ],
    "aestred-thurga-and-agathae-dolan": [
      { name: "Aestred Thurga", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "auto-of-castigation"], is_leader_model: true },
      { name: "Agathae Dolan", min: 1, max: 1, default_weapon_ids: ["close-combat-weapon"], is_leader_model: false },
    ],
    "daemonifuge": [
      { name: "Ephrael Stern", min: 1, max: 1, default_weapon_ids: ["bolt-pistol", "sanctity"], is_leader_model: true },
      { name: "Kyganil of the Bloody Tears", profile_name: "Kyganil of the Bloody Tears", min: 1, max: 1, default_weapon_ids: ["the-blades-of-the-harlequin"], is_leader_model: false },
    ],
  },
};

registerFaction(adeptaSororitas);

export default adeptaSororitas;

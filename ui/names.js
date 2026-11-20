// The game's things in plain words: unit, building, tech and tribe names from /api/meta, and a command as a short
// sentence ("Harvest the fruit", "Warrior attacks Xin-xi's archer"). Shared by the game screen and the review.

const NAMES = {
  babydragon: "Baby dragon", firedragon: "Fire dragon", transportship: "Transport ship", scoutship: "Scout ship",
  rammership: "Rammer ship", bombership: "Bomber ship", dragonegg: "Dragon egg", bugegg: "Bug egg", icefortress: "Ice fortress",
  icearcher: "Ice archer", mermaidwarrior: "Mermaid warrior", mermaidarcher: "Mermaid archer", mermaidswordsman: "Mermaid swordsman",
  mermaiddefender: "Mermaid defender", mermaidcloak: "Mermaid cloak", mermaiddagger: "Mermaid dagger", cloak_boat: "Cloak boat",
  lumberhut: "Lumber hut", clearforest: "Clear forest", burnforest: "Burn forest", growforest: "Grow forest",
  harvestfruit: "Harvest fruit", harvestspores: "Harvest spores", foresttemple: "Forest temple", watertemple: "Water temple",
  mountaintemple: "Mountain temple", icetemple: "Ice temple", icebank: "Ice bank", enchantanimal: "Enchant animal",
  polarisclimate: "Polaris climate", algaespawn: "Algae spawn", freespirit: "Free spirit", aquafarm: "Aqua farm",
  starfishing: "Starfishing", doubleattack: "Double attack", autofreeze: "Auto freeze", PopulationGrowth: "Population growth",
  BorderGrowth: "Border growth", CityWall: "City wall", SuperUnit: "Super unit",
  aimo: "Ai-Mo", xinxi: "Xin-xi",
};

export function pretty(id) {
  if (id == null) return "";
  const s = String(id);
  if (NAMES[s]) return NAMES[s];
  const t = s.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// a building or an action on a tile, as an order
const BUILD = {
  harvestfruit: "Harvest the fruit", hunting: "Hunt the animal", fishing: "Catch the fish", starfishing: "Gather the starfish",
  harvestspores: "Harvest the spores", clearforest: "Clear the forest", burnforest: "Burn the forest", growforest: "Grow a forest",
  enchantanimal: "Enchant the animal", fertilize: "Fertilise the land", polarisclimate: "Freeze the land",
};
// the terrain a unit moves onto
const ONTO = { 1: "into shallow water", 2: "out to the ocean", 3: "to a field", 4: "up a mountain", 5: "into a forest", 6: "onto the ice", 7: "into the wetland" };
const CITY = 1, RUIN = 2;

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const article = (s) => (/^[aeiou]/i.test(s) ? "an" : "a");
const where = (xy) => (Array.isArray(xy) ? `(${xy[0]}, ${xy[1]})` : "");

// `meta`: /api/meta. `who(player id)`: a player's name in a sentence (a tribe name). Returns the lookups and
// `describe(cmd, position)`: `cmd` as the engine sends commands (kind, from, to, unit_type, ...), `position` the one it
// is played from (optional; without it places are coordinates).
export function createWords(meta, who = (id) => `Player ${id}`) {
  const e = (meta && meta.engine) || {};
  const table = (list) => new Map((list || []).map((x) => [x.idx, x.id]));
  const units = table(e.units), techs = table(e.techs), improvements = table(e.improvements);
  const unitName = (i) => pretty(units.get(i) || `unit ${i}`);
  const techName = (i) => pretty(techs.get(i) || `tech ${i}`);
  const buildingId = (i) => improvements.get(i) || `building ${i}`;

  function tileAt(pos, xy) {
    if (!pos || !Array.isArray(xy)) return null;
    const t = (pos.tiles || []).find((x) => x.x === xy[0] && x.y === xy[1]) || null;
    if (!t) return null;
    const rec = (pos.improvements || []).find((r) => r.x === xy[0] && r.y === xy[1]);
    return { ...t, name: (rec && rec.name) || t.name || "", owner: t.owner || (rec && rec.owner) || 0 };
  }
  const isCity = (t) => !!t && (t.improvement === CITY || !!t.city);
  const cityName = (t) => (isCity(t) && t.owner ? t.name || "the city" : null);

  function place(pos, xy) {
    const t = tileAt(pos, xy);
    if (!t || !t.terrain) return `to ${where(xy)}`;
    if (isCity(t)) return t.owner ? `into ${t.name || "the city"}` : "onto a village";
    if (t.improvement === RUIN) return "to the ruins";
    return ONTO[t.terrain] || `to ${where(xy)}`;
  }

  function build(c, pos) {
    const id = buildingId(c.improvement);
    if (BUILD[id]) return BUILD[id];
    if (/^monument\d$/.test(id)) return "Build a monument";
    const name = lower(pretty(id));
    const t = tileAt(pos, c.to);
    const near = cityName(t);
    return `Build ${article(name)} ${name}${near ? ` in ${near}` : ""}`;
  }

  function describe(c, pos) {
    if (!c) return "";
    const unit = c.unit_type != null ? unitName(c.unit_type) : "Unit";
    switch (c.kind) {
      case "Move": return `${unit} moves ${place(pos, c.to)}`;
      case "Attack": {
        const target = c.target_type != null ? lower(unitName(c.target_type)) : "unit";
        return `${unit} attacks ${c.target_owner != null ? `${who(c.target_owner)}'s ${target}` : `the ${target}`}`;
      }
      case "Capture": {
        const t = tileAt(pos, c.to);
        return t && isCity(t) && !t.owner ? `${unit} takes a village` : `${unit} captures ${cityName(t) || "the city"}`;
      }
      case "Train": {
        const name = lower(unitName(c.train));
        const city = cityName(tileAt(pos, c.to));
        return `Train ${article(name)} ${name}${city ? ` in ${city}` : ""}`;
      }
      case "Build": return build(c, pos);
      case "Destroy": {
        const t = tileAt(pos, c.to);
        return t && t.improvement ? `Destroy the ${lower(pretty(buildingId(t.improvement)))}` : "Destroy the building";
      }
      case "Research": return `Research ${techName(c.tech)}`;
      case "CityReward": return `${cityName(tileAt(pos, c.to)) || "The city"} picks ${lower(pretty(c.reward))}`;
      case "Upgrade": return `Upgrade the ${lower(unit)} to ${article(unitName(c.upgrade_to))} ${lower(unitName(c.upgrade_to))}`;
      case "Stay": return `${unit} stays put`;
      case "Recover": return `${unit} heals`;
      case "HealOthers": return `${unit} heals the units around it`;
      case "Promote": return `Promote the ${lower(unit)}`;
      case "ExamineRuins": return `${unit} explores the ruins`;
      case "Disband": return `Disband the ${lower(unit)}`;
      case "EndTurn": return "End the turn";
      case "PeaceTreaty": return `Offer peace to ${who(c.with)}`;
      case "PeaceResponse": return `${c.accept ? "Accept" : "Refuse"} peace with ${who(c.with)}`;
      case "BreakPeace": return `Break the peace with ${who(c.with)}`;
      case "EstablishEmbassy": return `Open an embassy with ${who(c.with)}`;
      default: return c.unit_type != null ? `${unit}: ${lower(pretty(c.kind))}` : pretty(c.kind || c.text || "");
    }
  }

  return { unitName, techName, buildingName: (i) => pretty(buildingId(i)), describe };
}

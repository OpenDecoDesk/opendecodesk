// Invented customer names and addresses for generated orders. None of them is a real person or
// business; every contact is at example.com (reserved for examples).
const FIRST = ["Alex", "Sam", "Jordan", "Casey", "Riley", "Morgan", "Taylor", "Jamie", "Avery", "Quinn", "Drew", "Rowan", "Skyler", "Emerson", "Reese", "Hayden"];
const LAST = ["Sample", "Example", "Placeholder", "Tester", "Demo", "Fictional", "Madeup", "Specimen", "Mockley", "Dummy", "Pretend", "Notreal"];
const TEAMS = ["Rowing Club", "Booster Club", "Swim Team", "Garden Society", "Chess Club", "Robotics Team", "Book Club", "Run Club"];

// A small seeded random number generator (mulberry32), so every run makes the same data.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(r, what) {
  const f = FIRST[Math.floor(r() * FIRST.length)], l = LAST[Math.floor(r() * LAST.length)];
  if (what === "email") return (f + "." + l + Math.floor(r() * 1000)).toLowerCase() + "@example.com";
  if (what === "team") return TEAMS[Math.floor(r() * TEAMS.length)];
  return r() < 0.15 ? f + " " + l + " (" + TEAMS[Math.floor(r() * TEAMS.length)] + ")" : f + " " + l;
}

module.exports = { rng, pick };

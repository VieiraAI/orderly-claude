/**
 * A plain-English term, how it is said now, and what it actually means.
 *
 * Used for the live row while Claude is working, so a wait teaches you
 * something. Entries are grouped by what they are for; `TERMS` is the flat
 * list everything else works from.
 *
 * Each entry:
 *   plain — the ordinary phrase
 *   genz  — how it is commonly said now
 *   note  — what it means, in one line
 *   tag   — the group it came from
 */

const GROUPS = {
  praise: [
    ['Excellent', 'peak', 'as good as it gets'],
    ['The very best', 'goated', 'greatest of all time'],
    ['Impressive', 'fire', 'genuinely good, said with enthusiasm'],
    ['Really good', 'slaps', 'hits hard — usually music or food'],
    ['Delicious', 'bussin', 'very good, said of food'],
    ['Did it flawlessly', 'ate', 'performed with total confidence'],
    ['Left nothing to improve', 'ate and left no crumbs', 'flawless, with style'],
    ['Did exactly what was needed', 'understood the assignment', 'read the brief perfectly'],
    ['Stylish', 'clean', 'sharp and well put together'],
    ['Exceptionally skilled', 'cracked', 'unreasonably good at something'],
    ['Overpowered', 'OP', 'so strong it feels unfair'],
    ['A win', 'a W', 'a success worth claiming'],
    ['A small victory', 'small W', 'a modest but real win'],
    ['Admirable', 'valid', 'fair enough, respect it'],
    ['Memorable moment', 'core memory', 'something you will keep'],
  ],
  criticism: [
    ['Mediocre', 'mid', 'distinctly average, often overrated'],
    ['Poor quality', 'trash', 'bad, with no softening'],
    ['A failure', 'an L', 'a loss you have to wear'],
    ['Accept the defeat', 'take the L', 'admit it did not work'],
    ['Badly outclassed', 'washed', 'past it, or thoroughly beaten'],
    ['Thoroughly beaten', 'got cooked', 'comprehensively outdone'],
    ['Harsh', 'brutal', 'true but unkind'],
    ['Ruined it', 'fumbled', 'had it and lost it'],
    ['Wasted the opportunity', 'fumbled the bag', 'lost something valuable through error'],
    ['Gave up under pressure', 'folded', 'caved when it counted'],
    ['Excessive flattery', 'glazing', 'praising someone far past the point of sense'],
    ['Trying too hard', 'extra', 'more than the moment called for'],
    ['Attention-seeking', 'doing the most', 'unnecessary effort, loudly'],
    ['Questionable behaviour', 'crazy work', 'a quiet way of saying that was a choice'],
    ['Unappealing', 'not it', 'misses the mark'],
  ],
  agreement: [
    ['Agreed', 'bet', 'yes — agreement and sign-off in one word'],
    ['Understood', 'say less', 'no more explanation needed'],
    ['Honestly', 'no cap', 'said without exaggeration'],
    ['I mean it', 'deadass', 'completely serious'],
    ['Truthfully', 'fr', 'short for "for real" — tacked on to confirm you mean it'],
    ['Exactly right', 'facts', 'agreeing firmly'],
    ['Enough said', 'period', 'the point is closed'],
    ['That is untrue', 'cap', 'a lie; "no cap" is its opposite'],
    ['Stop exaggerating', 'stop capping', 'a direct call to stop lying'],
    ['That follows', 'tracks', 'consistent with what we know'],
    ['We already knew', 'we been knew', 'this is not news'],
    ['Fair point', 'real', 'honest and true'],
  ],
  effort: [
    ['Concentrating', 'locked in', 'fully focused, nothing else exists'],
    ['Working hard', 'grinding', 'sustained unglamorous effort'],
    ['Making good progress', 'cooking', 'something good is coming'],
    ['Let them continue', 'let them cook', 'leave them to it, they know'],
    ['Exhausted', 'cooked', 'completely spent'],
    ['Beyond saving', 'cooked', 'done for — same word, worse news'],
    ['Doing it quickly', 'speed running it', 'going for the fastest possible route'],
    ['Easily done', 'light work', 'barely any effort required'],
    ['Taking the risk', 'sending it', 'going ahead regardless'],
    ['Finished', 'wrapped', 'complete, hands off'],
    ['Committed to it', 'all in', 'no hedging left'],
    ['Pacing yourself', 'on go', 'steady and ready'],
  ],
  emotion: [
    ['Embarrassing', 'an ick', 'a small thing that kills the appeal'],
    ['Excruciating to watch', 'cringe', 'secondhand embarrassment'],
    ['Astonishing', 'wild', 'hard to believe'],
    ['Completely unhinged', 'unhinged', 'chaotic in an entertaining way'],
    ['Overexcited', 'feral', 'excitement past composure'],
    ['Thrilled', 'hyped', 'genuinely excited'],
    ['Startled', 'shook', 'caught off guard'],
    ['Emotional', 'in my feels', 'sitting with it'],
    ['Quietly jealous', 'pressed', 'bothered and showing it'],
    ['Unaffected', 'unbothered', 'it does not reach you'],
    ['Overthinking', 'in my head', 'spiralling privately'],
    ['Hopelessly optimistic', 'delulu', 'believing it against the evidence'],
    ['Infatuated', 'down bad', 'obviously, embarrassingly keen'],
  ],
  social: [
    ['Close friend', 'bestie', 'your person — often used warmly to strangers too'],
    ['Friends collectively', 'the gang', 'your group, nothing to do with crime'],
    ['Rival', 'opp', 'someone on the other side of it'],
    ['Showing off', 'flexing', 'displaying what you have'],
    ['Charisma', 'rizz', 'the ability to charm'],
    ['Genuine', 'real', 'honest, with no performance to it'],
    ['Insincere', 'fake', 'performing a self'],
    ['Suspicious', 'sus', 'something is off'],
    ['Gossip', 'tea', 'the information everyone wants'],
    ['Share the gossip', 'spill the tea', 'tell us everything'],
    ['Reputation', 'aura', 'the impression you give off'],
    ['Lost credibility', 'aura points gone', 'damaged standing, usually self-inflicted'],
    ['Ignoring someone', 'ghosting', 'disappearing without a word'],
    ['Read and not answered', 'left on read', 'seen, not replied to'],
    ['Awkward silence', 'crickets', 'no response at all'],
    ['Atmosphere', 'the vibe', 'how a thing feels'],
    ['Spoiling the mood', 'killing the vibe', 'making it worse by being there'],
    ['Assessing someone', 'vibe check', 'a quick read on whether they are alright'],
    ['Self-absorbed', 'main character syndrome', 'behaving as though everyone is watching'],
    ['Unremarkable bystander', 'NPC', 'going through the motions'],
    ['Talking at length', 'yapping', 'saying a great deal, mostly filler'],
    ['Someone who talks too much', 'a yapper', 'affectionately, a chatterbox'],
  ],
  intensity: [
    ['Slightly', 'lowkey', 'a little, and quietly'],
    ['Very much', 'highkey', 'a lot, and openly'],
    ['Extremely', 'hella', 'a great deal of it'],
    ['Without exaggeration', 'straight up', 'plainly and directly'],
    ['To be honest', 'ngl', 'short for "not gonna lie" — signals a candid aside'],
    ['In all seriousness', 'on God', 'the strongest way to swear something is true'],
    ['Somewhat', 'kinda', 'partially — the hedge that never left'],
  ],
  action: [
    ['Leaving', 'dipping', 'leaving, usually quietly and at once'],
    ['Calm down', 'chill', 'lower the temperature'],
    ['Back off', 'fall back', 'step away and give it room'],
    ['Go for it', 'send it', 'commit and find out'],
    ['Copying someone', 'biting', 'taking their idea as yours'],
    ['Earn the money', 'secure the bag', 'get what you came for'],
    ['The opportunity', 'the bag', 'the thing worth having'],
    ['Convinced me', 'sold', 'no further argument needed'],
    ['Predicted it', 'called it', 'saw it coming and said so'],
    ['No longer relevant', 'dead', 'over, finished, moved on from'],
  ],
};

export const TERMS = Object.entries(GROUPS).flatMap(([tag, rows]) =>
  rows.map(([plain, genz, note]) => ({ plain, genz, note, tag })),
);

export const CATEGORIES = Object.keys(GROUPS);

/** Fisher–Yates, so a pass shows every term before any repeats. */
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A rotation that works through every term before starting again, so the
 * same word does not come round twice in a short wait.
 */
export function createRotation(terms = TERMS) {
  let order = shuffle(terms);
  let i = 0;
  return {
    next() {
      if (i >= order.length) { order = shuffle(terms); i = 0; }
      return order[i++];
    },
    peek() { return order[Math.min(i, order.length - 1)]; },
    get size() { return terms.length; },
  };
}

/** Terms whose plain phrase, slang or meaning matches — for a lookup field. */
export function find(query, terms = TERMS) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return terms.filter((t) =>
    t.plain.toLowerCase().includes(q)
    || t.genz.toLowerCase().includes(q)
    || t.note.toLowerCase().includes(q));
}

export function byCategory(tag, terms = TERMS) {
  return terms.filter((t) => t.tag === tag);
}

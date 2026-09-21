// How much two runs of the golden journeys are allowed to differ.
//
// One file, on purpose. When a comparison fails and somebody has to decide
// whether the difference is a regression or a slow afternoon, this is the
// only place to look and the only place to argue with.
//
// The rule everywhere else is equality. A number not named below must come
// out the same before a change and after it, and a number that moves is a
// failure until a person says otherwise.

/**
 * Numeric slack, by the dot-path of the fact in the parity record.
 * The value is the largest absolute difference that still counts as equal.
 */
export const TOLERANCES = {
  // Reading time for the twelve-second read in J2. WIDENED on 21 September
  // 2026, from six seconds to ten: the clock no longer stops at the first
  // idle moment, it keeps running for up to thirty seconds after the last
  // input. So where a section boundary falls relative to the last scroll now
  // moves the recorded figure by several seconds in a way it never used to,
  // and two honest runs of the same journey differ more than they did. Ten
  // is still far below the thirty-second allowance itself, so a clock that
  // reverted to counting tab-open time cannot hide inside it.
  'j3.db.active_seconds': 10,

  // What the report prints, from the same measurement, rounded again for
  // display. Same slack as the database figure plus the rounding.
  'j3.screen.active_seconds': 11,

  // Section rows. The fixture has three headings and the deck's h1 sometimes
  // qualifies as a fourth section depending on how far the scroll settles,
  // so one either way is normal. Two would mean a section stopped being
  // detected at all.
  'j3.db.section_events': 1,

  // The reading-time journey. NARROWER than J3's, deliberately: each of
  // these readers is a fixed, scripted amount of wall clock against a flat
  // allowance, so the answer is arithmetic rather than a measurement of how
  // fast a page happened to settle. Four seconds covers heartbeat jitter and
  // nothing else — these are the numbers that would move if the allowance,
  // the warm-up credit or the visibility rule changed, and moving them is
  // exactly what must not pass silently.
  'j10a.db.silent_seconds': 4,
  'j10b.db.nudged_seconds': 4,
  'j10c.db.walked_away_seconds': 4,

  // The average of four scripted readers, printed on the report. One more
  // second of slack than its parts, because averaging four rounded figures
  // rounds once more.
  'j10e.screen.avg_reading_time': 5,
};

/**
 * Facts that differ between two honest runs and say nothing about the
 * product. Matched as a prefix of the dot-path.
 */
export const IGNORED = [
  'recordedAt', // when the run happened
  'baseUrl', // before is usually a preview, after is usually production
];

/** Everything not named in TOLERANCES must match exactly. */
export const DEFAULT_TOLERANCE = 0;

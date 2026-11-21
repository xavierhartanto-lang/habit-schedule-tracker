/**
 * Home's quote of the day. A short, curated list kept in the code: no AI
 * call and no network, so it loads instantly and never says something odd.
 * Only quotes with a solid source are attributed; Whitespace's own lines
 * have no author. Pure, so it is tested.
 */

export type Quote = { text: string; author: string | null };

export const QUOTES: readonly Quote[] = [
  { text: "How we spend our days is, of course, how we spend our lives.", author: "Annie Dillard" },
  { text: "You do not rise to the level of your goals. You fall to the level of your systems.", author: "James Clear" },
  { text: "Every action you take is a vote for the type of person you wish to become.", author: "James Clear" },
  { text: "It is not that we have a short time to live, but that we waste a lot of it.", author: "Seneca" },
  { text: "The impediment to action advances action. What stands in the way becomes the way.", author: "Marcus Aurelius" },
  { text: "Waste no more time arguing what a good man should be. Be one.", author: "Marcus Aurelius" },
  { text: "First say to yourself what you would be; and then do what you have to do.", author: "Epictetus" },
  { text: "The best way out is always through.", author: "Robert Frost" },
  { text: "You must do the thing you think you cannot do.", author: "Eleanor Roosevelt" },
  { text: "I am not afraid of storms, for I am learning how to sail my ship.", author: "Louisa May Alcott" },
  { text: "Be so good they can't ignore you.", author: "Steve Martin" },
  { text: "Amateurs sit and wait for inspiration, the rest of us just get up and go to work.", author: "Stephen King" },
  { text: "The first principle is that you must not fool yourself, and you are the easiest person to fool.", author: "Richard Feynman" },
  { text: "Almost everything will work again if you unplug it for a few minutes, including you.", author: "Anne Lamott" },
  { text: "Hope is a good breakfast, but it is a bad supper.", author: "Francis Bacon" },
  { text: "Imagination is more important than knowledge.", author: "Albert Einstein" },
  { text: "Well begun is half done.", author: "Aristotle" },
  { text: "Done is better than perfect.", author: null },
  { text: "Slow is smooth. Smooth becomes fast.", author: null },
  { text: "Simple scales.", author: null },
  { text: "Momentum beats motivation.", author: null },
  { text: "Protect your attention. It's the only thing you can't get back.", author: null },
  { text: "What you repeat becomes who you are.", author: null },
  { text: "Don't chase perfect. Finish.", author: null },
  { text: "Good systems outlive good intentions.", author: null },
  { text: "Win the boring days.", author: null },
  { text: "Rest is part of the work, not a break from it.", author: null },
  { text: "One hard thing first. The rest of the day gets lighter.", author: null },
  { text: "Busy is not the same as important.", author: null },
  { text: "A calm plan beats a long list.", author: null },
  { text: "Little by little, one travels far.", author: null },
];

/** The same quote all day, a different one tomorrow. `dateKey` is "YYYY-MM-DD" in the user's time zone. */
export function quoteForDay(dateKey: string, list: readonly Quote[] = QUOTES): Quote {
  const [y, m, d] = dateKey.split("-").map(Number);
  const day = Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000);
  // Step by a prime so neighbouring days don't land on neighbouring (often related) quotes.
  const i = (((day * 7) % list.length) + list.length) % list.length;
  return list[Number.isFinite(i) ? i : 0];
}

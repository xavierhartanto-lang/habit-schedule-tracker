/** A sample exchange used only to design the conversation layout. */
export const SAMPLE_CONVERSATION = [
  {
    id: "c1",
    role: "user" as const,
    text: "I have a chem test Thursday and a swim meet Saturday. When should I study?",
  },
  {
    id: "c2",
    role: "assistant" as const,
    text: "You have three open evenings before Thursday. A good split would be 60 minutes Monday after practice, 90 minutes Tuesday after violin, and a short review Wednesday morning.",
    suggestions: [
      { day: "Mon", time: "7:30 – 8:30 PM", title: "Chem: units 5–6" },
      { day: "Tue", time: "7:45 – 9:15 PM", title: "Chem: practice test" },
      { day: "Wed", time: "7:15 – 7:45 AM", title: "Chem: quick review" },
    ],
  },
];

export const SAMPLE_THREADS = [
  { id: "s1", title: "Chem test study plan", when: "Today" },
  { id: "s2", title: "Balancing robotics season", when: "Yesterday" },
  { id: "s3", title: "Weekend reset routine", when: "Mon" },
  { id: "s4", title: "SAT prep timeline", when: "Last week" },
];

export const SUGGESTED_PROMPTS = [
  "Plan my week around swim and debate",
  "Where can I fit SAT prep?",
  "I'm overloaded on Wednesday. Help me rebalance.",
  "Build a routine for violin practice",
];

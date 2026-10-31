// The agile trail's card decks. The deck shape and its mission live in
// src/lib/cards.ts; every deck is registered in src/lib/decks.ts.

import { deckMission, type Deck } from '../cards.ts';

export const IN_NAME_ONLY: Deck = {
  id: 'in-name-only', title: 'Diagnose four teams', xp: 60,
  cards: [
    {
      id: 'standup', title: 'Team Kestrel',
      body: 'Every morning each developer tells the engineering manager what they did yesterday and what they will do today. The manager reassigns work on the spot. It takes 35 minutes.',
      options: [
        { id: 'healthy', text: 'Healthy: they meet every day', why: 'Meeting daily is not the point. Who is the meeting for, and who decides the plan?' },
        { id: 'status', text: 'The Daily Scrum has become a status meeting for a manager', why: 'This is the pattern Ron Jeffries calls Dark Scrum: the event runs, but the developers no longer own their plan.' },
        { id: 'longer', text: 'They need a longer meeting to cover everything', why: 'The Scrum Guide timeboxes the Daily Scrum at 15 minutes, for the Developers. Longer makes the status-meeting problem bigger.' },
      ],
      answer: 'status', source: 'Ron Jeffries, Dark Scrum (2016); Scrum Guide 2020',
    },
    {
      id: 'hardening', title: 'Team Heron',
      body: 'Items are moved to "Done" when the code is written. Testing happens later, and every fourth sprint is a "hardening sprint" spent fixing what the first three left behind.',
      options: [
        { id: 'event', text: 'Healthy: hardening is a normal Scrum event', why: 'The Scrum Guide has five events and none of them is a hardening sprint.' },
        { id: 'longer', text: 'Their sprints are too short', why: 'Longer sprints move the testing further away; they do not make "Done" mean done.' },
        { id: 'notdone', text: '"Done" does not mean tested and integrated, so the increment is not really done', why: 'The Scrum Guide: an item that does not meet the Definition of Done "cannot be released or even presented at the Sprint Review". The name "hardening sprint" is our inference from that rule, not a term the guide uses.' },
      ],
      answer: 'notdone', source: 'Scrum Guide 2020 (CC BY-SA 4.0); the hardening-sprint reading is inferred',
    },
    {
      id: 'velocity', title: 'Team Osprey',
      body: 'A monthly slide ranks every team by velocity. Osprey has climbed from fifth to first in three months. The number of items its users actually received has not changed.',
      options: [
        { id: 'target', text: 'Velocity has become a target, and comparing teams by it rewards inflating estimates', why: 'Ron Jeffries: "I think comparing teams on quality of estimates or velocity is harmful." Throughput, an exact count, shows nothing changed.' },
        { id: 'best', text: 'Osprey is now the most productive team', why: 'Points are each team\'s own estimates. A ranking of estimates measures estimating.' },
        { id: 'healthy', text: 'Healthy: a rising velocity means improvement', why: 'Not when the count of delivered items is flat. That is the gap the forecasts lesson measured.' },
      ],
      answer: 'target', source: 'Ron Jeffries, Story Points Revisited (2019)',
    },
    {
      id: 'healthy', title: 'Team Plover',
      body: 'Plover ships tested, integrated changes to users every two weeks. Their last retrospective changed how they review code, and it stuck. Nobody outside the team asks for their velocity.',
      options: [
        { id: 'broken', text: 'Agile in name only: they do not report velocity', why: 'Velocity is not part of Scrum, and nothing here says the work is not getting done.' },
        { id: 'fine', text: 'Nothing here says it is in name only: working software ships and the team changes how it works', why: 'The Manifesto: "Working software is the primary measure of progress." A diagnosis has to be able to come back clear.' },
        { id: 'missing', text: 'They should add a hardening sprint to be safe', why: 'Their increments are already tested and integrated. A hardening sprint would only add a place for undone work to hide.' },
      ],
      answer: 'fine', source: 'Agile Manifesto principles (2001)',
    },
  ],
  debrief: 'Three of the four teams ran every ritual and still were not doing what the rituals are for; the fourth ran fewer and was. The test that cuts through every one: does tested, integrated, working software reach users each Sprint, and does the team own how it works? A diagnosis that can only ever say "broken" is as useless as one that always says "fine".',
};

// The quoted sentences in this deck are from the 2020 Scrum Guide by Ken
// Schwaber and Jeff Sutherland, https://scrumguides.org/scrum-guide.html,
// licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
// They are quoted, not adapted; if this deck is ever reworded from the guide,
// that wording must stay CC BY-SA too, not MIT like the rest of the site.
export const SCRUM_EVENTS: Deck = {
  id: 'scrum-events', title: 'What is each event for?', xp: 50,
  licence: 'Quotes: Scrum Guide 2020, Schwaber & Sutherland, CC BY-SA 4.0',
  cards: [
    {
      id: 'planning', title: 'Sprint Planning',
      body: 'The whole Scrum Team meets at the start of the Sprint, for at most eight hours if the Sprint is a month long.',
      options: [
        { id: 'purpose', text: 'To lay out the work for the Sprint: why it is valuable, what can be Done, and how', why: 'The guide: "Sprint Planning initiates the Sprint by laying out the work to be performed for the Sprint", around three topics - why, what, and how.' },
        { id: 'assign', text: 'For the manager to hand each developer their tasks for the week', why: 'The guide says the plan "is created by the collaborative work of the entire Scrum Team". Nobody hands it down.' },
        { id: 'habit', text: 'We always do it on the first Monday', why: 'A habit is not a purpose. If nobody can say what the event is for, it is the first thing to go wrong.' },
      ],
      answer: 'purpose', source: 'Scrum Guide 2020 (CC BY-SA 4.0)',
    },
    {
      id: 'daily', title: 'Daily Scrum',
      body: 'Every working day the Developers meet for 15 minutes.',
      options: [
        { id: 'status', text: 'To report status to the Scrum Master', why: 'The guide: "The Daily Scrum is a 15-minute event for the Developers of the Scrum Team." It is not a report to anyone.' },
        { id: 'purpose', text: 'To inspect progress toward the Sprint Goal and adapt the plan', why: 'The guide: "The purpose of the Daily Scrum is to inspect progress toward the Sprint Goal and adapt the Sprint Backlog as necessary, adjusting the upcoming planned work."' },
        { id: 'questions', text: 'To answer the three standard questions, in turn', why: 'The 2020 guide dropped the three questions. Developers "can select whatever structure and techniques they want", as long as it focuses on the Sprint Goal and produces an actionable plan.' },
      ],
      answer: 'purpose', source: 'Scrum Guide 2020 (CC BY-SA 4.0)',
    },
    {
      id: 'review', title: 'Sprint Review',
      body: 'Near the end of the Sprint, the Scrum Team meets key stakeholders, for at most four hours in a one-month Sprint.',
      options: [
        { id: 'gate', text: 'To approve the increment for release', why: 'The guide: "The Sprint Review should never be considered a gate to releasing value." Work can be released whenever it is done.' },
        { id: 'demo', text: 'To demo the work; the stakeholders watch and leave', why: 'The guide calls it "a working session" and says the team "should avoid limiting it to a presentation".' },
        { id: 'purpose', text: 'To inspect the outcome of the Sprint and decide what to adapt next', why: 'The guide: "The purpose of the Sprint Review is to inspect the outcome of the Sprint and determine future adaptations."' },
      ],
      answer: 'purpose', source: 'Scrum Guide 2020 (CC BY-SA 4.0)',
    },
    {
      id: 'retro', title: 'Sprint Retrospective',
      body: 'The Sprint ends with the Scrum Team looking back at how the last Sprint went, for at most three hours in a one-month Sprint.',
      options: [
        { id: 'habit', text: 'It is in the calendar, so we hold it', why: 'A retrospective held because it is scheduled, with nothing changing afterwards, is the ritual without the purpose.' },
        { id: 'purpose', text: 'To plan ways to increase quality and effectiveness', why: 'The guide: "The purpose of the Sprint Retrospective is to plan ways to increase quality and effectiveness."' },
        { id: 'blame', text: 'To find out who caused the missed goal', why: 'The guide asks the team to inspect "individuals, interactions, processes, tools" to improve them, not to assign blame.' },
      ],
      answer: 'purpose', source: 'Scrum Guide 2020 (CC BY-SA 4.0)',
    },
    {
      id: 'sprint', title: 'The Sprint',
      body: 'The team works in cycles of the same length, one month or less, one after another.',
      options: [
        { id: 'deadline', text: 'A deadline for every item in the Sprint Backlog', why: 'The commitment is the Sprint Goal. The guide says scope "may be clarified and renegotiated with the Product Owner as more is learned".' },
        { id: 'gap', text: 'A pause between releases', why: 'The guide: "A new Sprint starts immediately after the conclusion of the previous Sprint." There is no gap.' },
        { id: 'purpose', text: 'A container for all the other events, of a fixed length', why: 'The guide: "The Sprint is a container for all other events." Fixed length, one month or less, "to create consistency".' },
      ],
      answer: 'purpose', source: 'Scrum Guide 2020 (CC BY-SA 4.0)',
    },
  ],
  debrief: 'Every wrong answer in that deck is something real teams do: report to a manager, read three questions in turn, treat the review as a sign-off, hold the retrospective because it is in the calendar. Each one keeps the event and loses what it was for. The guide is strict about the frame and silent about almost everything inside it, which is why "what is this for?" is the question that keeps a team doing Scrum rather than performing it.',
};


export const IN_NAME_ONLY_MISSION = deckMission(IN_NAME_ONLY);
export const SCRUM_EVENTS_MISSION = deckMission(SCRUM_EVENTS);

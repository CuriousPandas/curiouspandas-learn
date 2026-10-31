// The Changing Running Software trail's card decks. The deck shape and its
// mission live in src/lib/cards.ts; every deck is registered in src/lib/decks.ts.
// Each deck has at least one card where the right reading is "this is fine",
// so a learner who calls everything dangerous does not pass.

import { deckMission, type Deck } from '../cards.ts';

export const ONE_WAY_DOORS: Deck = {
  id: 'one-way-doors', title: 'Which steps can be undone?', xp: 50,
  cards: [
    {
      id: 'cutover', title: 'One weekend, every customer',
      body: 'A bank moves all of its customers from the old platform to the new one over a single weekend. Once the new platform is live, the plan has no way to move them back.',
      options: [
        { id: 'reversible', text: 'Reversible: they can always restore last week\'s backup', why: 'A backup restores data, not a weekend of customers\' new transactions on the new system. The independent review of TSB found rollback was essentially impossible.' },
        { id: 'oneway', text: 'A one-way door: once through, the only direction is forward', why: 'Supported. A largely single-event migration was not necessarily wrong, the TSB review said - but with no way back, everything rested on the checks before it.' },
        { id: 'fine', text: 'Fine, as long as the data migration itself succeeds', why: 'At TSB the data migration did succeed. The platform behind it was not ready for the full customer base, and that is what failed.' },
      ],
      answer: 'oneway', source: 'FCA Final Notice to TSB (2022); Slaughter and May report (2019)',
    },
    {
      id: 'descoped', title: 'A test that got shorter',
      body: 'Weeks before the cut-over, testing of the two data centres running together is cut back. The decision is made outside the forum that normally approves such changes.',
      options: [
        { id: 'removed', text: 'A check removed in front of a one-way door, without the people meant to approve it', why: 'Supported. The FCA found this testing was reduced outside the appropriate governance forum, and that it would likely have found the defect that took digital banking down.' },
        { id: 'harmless', text: 'A scheduling change: the testing can be finished after launch', why: 'After a one-way step, a test that finds a problem can only tell you what is already broken for customers.' },
        { id: 'reversible', text: 'Reversible: they can add the testing back later', why: 'The scope can be restored; the launch it was meant to protect cannot be undone.' },
      ],
      answer: 'removed', source: 'FCA Final Notice to TSB (2022)',
    },
    {
      id: 'shadow', title: 'One route, in the shadow',
      body: 'A team puts a façade in front of the old system and shadows one read-only route to the new one for two weeks, comparing every answer. Users only ever see the old system\'s answers.',
      options: [
        { id: 'oneway', text: 'A one-way door: the new system is now in production', why: 'Nothing the user sees has changed, and turning the shadow off is a one-line rule change.' },
        { id: 'risky', text: 'Risky: real traffic should never touch a new system', why: 'For reads, comparing on real traffic is how GitHub found two long-hidden bugs. Writes are different; see the shadow lesson.' },
        { id: 'reversible', text: 'Reversible, and it produces evidence before anything is decided', why: 'Supported. This is the opposite of a one-way door: cheap to undo, and it tells you what the next step will cost.' },
      ],
      answer: 'reversible', source: 'GitHub, Move Fast and Fix Things (2015); this trail\'s shadow lesson',
    },
    {
      id: 'drop', title: 'Tidy up straight away',
      body: 'The morning after moving every route to the new system, a team drops the old database tables to save space.',
      options: [
        { id: 'fine', text: 'Fine: the migration is done', why: 'Done according to the plan. A caller nobody listed, or a bug found next week, now has nowhere to go back to.' },
        { id: 'oneway', text: 'A one-way door taken too early: rolling back now means restoring the tables and replaying every change since', why: 'Supported. Microsoft\'s strangler fig guidance: once legacy objects are dropped, rollback means you "must restore those objects and replay data changes".' },
        { id: 'reversible', text: 'Reversible: tables can be recreated', why: 'The structure can be recreated. The data written since cannot be put back without a replay.' },
      ],
      answer: 'oneway', source: 'Microsoft Azure Architecture Center, Strangler Fig pattern',
    },
  ],
  debrief: 'Two of those four steps could be walked back and two could not. The expensive failures in this trail all sat at a one-way step that nobody had checked: TSB\'s cut-over after its testing was cut, Atlassian\'s permanent delete, Knight\'s unverified deploy. A rewrite is a plan to take one very large one-way step; every pattern after this lesson is a way to take many small ones instead.',
};

export const GOLDEN_MASTER: Deck = {
  id: 'golden-master', title: 'Can this test fail?', xp: 50,
  cards: [
    {
      id: 'regenerated', title: 'The approved file was regenerated',
      body: 'A refactor changed the output of a report and the approval test went red. A developer, sure the new output was right, re-approved it without reading the diff. It was a bug.',
      options: [
        { id: 'fine', text: 'Fine: the test is green again', why: 'Green against a reference that now contains the bug. The test checks that the code does whatever it currently does.' },
        { id: 'assertsbug', text: 'The test now asserts the bug, and will fail if anyone fixes it', why: 'Supported. J. B. Rainsberger\'s advice is to make regenerating a golden master a deliberate, separate step, never the reflex when a test goes red.' },
        { id: 'flaky', text: 'The test is flaky and should be deleted', why: 'It is not flaky: it fails every time the output changes. That is its job.' },
      ],
      answer: 'assertsbug', source: 'J. B. Rainsberger, How not to write golden master tests',
    },
    {
      id: 'scrubber', title: 'A generous scrubber',
      body: 'The output contains timestamps, so a scrubber replaces them before comparing. To be safe, it replaces every digit in the file.',
      options: [
        { id: 'blind', text: 'The test can no longer see a wrong number anywhere in the output', why: 'Supported, and it is our inference rather than a published incident: a scrubber this broad turns every numeric change into a match.' },
        { id: 'fine', text: 'Fine: it removes all the noise', why: 'It removes the noise and every price, count and total along with it. Scrub the fields that vary, not the whole category.' },
        { id: 'slow', text: 'The only cost is speed', why: 'The cost is that the test passes when the numbers are wrong.' },
      ],
      answer: 'blind', source: 'Inference from ApprovalTests scrubbers; compare the Strangler Lab\'s "ignore all numeric fields"',
    },
    {
      id: 'pinned', title: 'A test that pins a known oddity',
      body: 'Legacy code rounds half-pennies down. A new characterization test asserts exactly that, with a comment: "current behaviour, not necessarily correct - see ticket".',
      options: [
        { id: 'wrong', text: 'Wrong: tests should only assert correct behaviour', why: 'A characterization test records what the code does today, right or wrong, so you can change it without changing behaviour by accident.' },
        { id: 'useless', text: 'Useless: it will never catch anything', why: 'It catches any change to rounding, including an accidental one during a refactor.' },
        { id: 'good', text: 'Doing its job: it pins today\'s behaviour on purpose, and says so', why: 'Supported. Fixing the rounding becomes a deliberate change, with this test updated alongside it, not a surprise.' },
      ],
      answer: 'good', source: 'Michael Feathers, Working Effectively with Legacy Code (2004), as summarised',
    },
  ],
  debrief: 'A characterization test is only as good as its reference. Re-approve without reading and the reference is wrong; scrub too much and the test is blind; pin an oddity on purpose and say so, and the test is doing exactly what Feathers meant. The question to ask of any approval test: what change to the code would make it fail?',
};

export const FLAG_DEBT: Deck = {
  id: 'flag-debt', title: 'Is this flag a liability?', xp: 50,
  cards: [
    {
      id: 'reused', title: 'A recycled flag',
      body: 'A team needs a switch for a new feature and reuses an old flag name instead of adding one. Some old code, unused for years, still checks that flag.',
      options: [
        { id: 'tidy', text: 'Tidy: fewer flags to manage', why: 'Fewer names, and one of them now switches on code nobody meant to run.' },
        { id: 'bomb', text: 'A time bomb: turning the flag on can run the forgotten code', why: 'Supported. This is how Knight Capital lost over $460 million in 45 minutes; Google\'s SRE book calls code behind an always-off flag "a metaphorical time bomb".' },
        { id: 'fine', text: 'Fine, as long as the flag is off', why: 'It is only fine until someone turns it on, which is the reason it exists.' },
      ],
      answer: 'bomb', source: 'SEC order, Knight Capital (2013); Site Reliability Engineering, ch. 9',
    },
    {
      id: 'forever', title: 'The flag that stayed',
      body: 'A release flag went to 100% eighteen months ago. Both code paths are still in the codebase, and every test runs both.',
      options: [
        { id: 'inventory', text: 'Inventory with a carrying cost: remove the flag and the dead path', why: 'Supported. Pete Hodgson: savvy teams treat their feature toggles as inventory with a carrying cost, and keep that inventory low.' },
        { id: 'safety', text: 'A safety net worth keeping', why: 'After eighteen months at 100%, turning it off would run code nobody has used in production for a year and a half.' },
        { id: 'free', text: 'Free: the flag costs nothing while it is on', why: 'Both paths still need testing, reading and upgrading. Uber built a tool, Piranha, to remove thousands of stale flags.' },
      ],
      answer: 'inventory', source: 'Pete Hodgson, Feature Toggles (martinfowler.com); Uber, Piranha',
    },
    {
      id: 'expiring', title: 'A flag with an end date',
      body: 'A new flag is created with an owner and an expiry date. Two weeks after full rollout, a ticket to delete it and the old path is already scheduled.',
      options: [
        { id: 'overkill', text: 'Overkill for a simple switch', why: 'The expiry is what stops a simple switch becoming next year\'s eighteen-month flag.' },
        { id: 'risky', text: 'Risky: deleting the old path removes the way back', why: 'Two weeks at 100% is the evidence that the way back is no longer needed. The flag did its job.' },
        { id: 'healthy', text: 'Healthy: the flag is temporary, and its removal is part of the work', why: 'Supported. This is the contract step of branch by abstraction, planned from the start.' },
      ],
      answer: 'healthy', source: 'Pete Hodgson, Feature Toggles; Danilo Sato, ParallelChange',
    },
  ],
  debrief: 'A flag is a branch that lives in production. The one with an owner and an end date was finished work; the one that stayed for eighteen months was inventory; the recycled one was a fuse. Branch by abstraction ends when the old implementation, and then the switch between them, are deleted - and that last step is the one that gets skipped.',
};

export const API_CHANGES: Deck = {
  id: 'api-changes', title: 'Will this change break a client?', xp: 50,
  cards: [
    {
      id: 'optional', title: 'A new optional field',
      body: 'An API starts returning an extra field, "currency", alongside the existing ones. Nothing is removed or renamed.',
      options: [
        { id: 'expand', text: 'An expand step: safe for clients that ignore fields they do not know', why: 'Supported, with that condition. Martin Fowler\'s Tolerant Reader is a client that takes only what it needs and ignores the rest.' },
        { id: 'breaking', text: 'Breaking: any change to a response is breaking', why: 'Adding is the safest change there is - for tolerant clients. A client that rejects unknown fields will break, which is why the condition matters.' },
        { id: 'needsversion', text: 'Needs a new API version', why: 'Versioning every addition multiplies the versions you maintain. Stripe keeps its old versions working, and says each one is more code to maintain.' },
      ],
      answer: 'expand', source: 'Martin Fowler, TolerantReader; Stripe, API versioning',
    },
    {
      id: 'order', title: 'A different order',
      body: 'A refactor changes the order in which a list endpoint returns items. The documentation never promised any order.',
      options: [
        { id: 'safe', text: 'Safe: the contract never promised an order', why: 'The contract never did. Some client almost certainly does anyway.' },
        { id: 'hyrum', text: 'Probably breaking for someone: every observable behaviour gets depended on', why: 'Supported. Hyrum\'s Law: with enough users, all observable behaviours of your system will be depended on by somebody, whatever the contract says.' },
        { id: 'docs', text: 'Only a documentation problem', why: 'The documentation is correct. The client that sorted by assuming the old order is what breaks.' },
      ],
      answer: 'hyrum', source: 'hyrumslaw.com; Software Engineering at Google, ch. 1',
    },
    {
      id: 'heartbeat', title: 'One deploy, two formats',
      body: 'Servers send each other a heartbeat every 5 seconds. A deploy changes it to 10 seconds, reading and writing the new interval at once. It rolls out a few servers at a time.',
      options: [
        { id: 'safe', text: 'Safe: every server gets the change eventually', why: 'Eventually. During the rollout, old and new servers disagree, and in a single-server test environment that mixed fleet never exists.' },
        { id: 'twophase', text: 'Breaks during the rollout: deploy the reading side first, then the writing side', why: 'Supported. AWS\'s two-phase deployment: readers go before writers while rolling forward, with time between the two.' },
        { id: 'rollback', text: 'Fine, because it can be rolled back', why: 'Rolling back recreates the mixed fleet in the other direction. The fix is to make both versions able to read both formats first.' },
      ],
      answer: 'twophase', source: 'AWS, Ensuring rollback safety during deployments',
    },
  ],
  debrief: 'Adding was safe because clients ignore what they do not know; reordering was not, because somebody depended on what was never promised; and a format change broke only in the middle of its own rollout. Every API change is expand and contract across a boundary you do not control: add the new thing, let the readers catch up, and only then take the old thing away.',
};

export const ONE_WAY_DOORS_MISSION = deckMission(ONE_WAY_DOORS);
export const GOLDEN_MASTER_MISSION = deckMission(GOLDEN_MASTER);
export const FLAG_DEBT_MISSION = deckMission(FLAG_DEBT);
export const API_CHANGES_MISSION = deckMission(API_CHANGES);

// Public character overviews for /meet-the-cast: an archetype role label
// and a short humanizing blurb per character. Keyed by `${bookSlug}:${name}`.
// Public copy only: no voice or audio information lives here.
//
// AUTHORING RULE for new characters (the blurb/bio split, fixed
// 2026-10-31 after a full-cast pass found the bios restating the
// blurbs): the blurb states the character's defining take ONCE. The
// CAST_BIOS entry below (two paragraphs) must ADD new texture only:
// habits, small scenes, relationships with castmates, what is at
// stake for them. Never restate the blurb in near-verbatim form.
// Invent texture, not plot: nothing beyond what the book's bible
// establishes. The same rule lives in the factory's bible prompt
// (kidsbook-factory super_bible_prompt.md, Characters section).

export interface CastOverview {
  role: string;
  blurb: string;
}

export const CAST_OVERVIEWS: Record<string, CastOverview> = {
  // Mira the Heron and the Still Water (mastery)
  "mastery:Mira": {
    role: "The Learner",
    blurb:
      "Mira is the one with the want: to fish the Still Pool like the masters in the old stories. She begins eager, grows frustrated when the fish will not come, and has to wrestle with her own pride before she settles into the work. She is every kid who has ever wanted to be good at something and learned that wanting is only the first step.",
  },
  "mastery:Ansel": {
    role: "The Guide",
    blurb:
      "Ansel is the old master of the Still Pool, and the worn path along his bank is the record of a lifetime of mornings. He speaks rarely and slowly, often in a single word, and his patience never seems to run out. He never carries Mira past the hard parts. He shows her how to stand in them.",
  },
  "mastery:Dell": {
    role: "The Comfort Zone",
    blurb:
      "Dell is round, bouncy, and always off to try a brand new hobby, preferably one he can be great at by Friday. He loves Mira, cheers loudly for her, and now and then drops a piece of real wisdom entirely by accident. He stands for the easy, playful, unstructured life Mira is learning to leave behind, and he is never the villain of her story.",
  },
  "mastery:The Otter": {
    role: "The Shortcut",
    blurb:
      "The Otter is charm with a plan. Slick, quick talking, and a little too eager to help, he talks Mira out of her good fishing spot with a story that is not true. He is the temptation of easy success, and the dry ditch at the end of it teaches Mira more than he ever meant to.",
  },
  // Fern the Fox and the Clever Trails (algorithms)
  "algorithms:Fern": {
    role: "The Pathfinder",
    blurb:
      "Fern wants every errand done the fastest way there is, and the forest keeps proving that fast is not always smart. Quick and clever, she learns to break big problems into small steps and to choose carefully at every fork in the trail. She is the part of every kid that would rather figure out the way than wander it.",
  },
  "algorithms:Moss": {
    role: "The Keeper of Notes",
    blurb:
      "Moss moves slowly, writes everything down, and never has to solve the same problem twice. While Fern dashes ahead, Moss keeps the book of answers the whole forest can use again. He shows young readers that remembering is a kind of cleverness too.",
  },
  "algorithms:Orin": {
    role: "The Big Picture",
    blurb:
      "Orin the owl sees the whole forest from above and keeps its great map correct, down to the last clearing and trail. Patient and wise, he teaches Fern to split one huge problem into smaller ones she can actually carry. He is the calm voice that asks, before anything else, what the whole trail looks like.",
  },
  // Maisie the Mouse and the Jar That Grew (compoundeffect)
  "compoundeffect:Maisie": {
    role: "The Promise Keeper",
    blurb:
      "Maisie wants a winter store so full that her family never has to be afraid of the cold months. She is curious and impatient at first, until she makes one small promise out loud and starts keeping it, a few grains at a time. Her story shows kids that tiny choices, repeated every day, quietly grow into something enormous.",
  },
  "compoundeffect:Jasper": {
    role: "The Quick Fix",
    blurb:
      "Jasper is big hearted, funny, and famous for loving feasts and shortcuts in equal measure. He quits the moment a job gets boring, then feels sorry about it later, in private. He is the voice in every kid that wants the biggest pile today, with the least carrying possible.",
  },
  "compoundeffect:Willa": {
    role: "The Long View",
    blurb:
      "Willa speaks in small numbers, counts everything, and is in no hurry at all. She has watched tiny grains become full granaries for more winters than anyone can remember. She teaches Maisie, and young readers, what time does to small things done faithfully.",
  },
  // Basil the Beaver and the Pattern Book (designpatterns)
  "designpatterns:Basil": {
    role: "The Builder",
    blurb:
      "Basil is an enthusiastic young builder who is strong first and thoughtful second, and proud of every dam he raises. He wants the whole creek to trust his work the way it trusts Ada's. His story is about learning that good builders do not start from scratch. They reach for proven shapes and adapt them with care.",
  },
  "designpatterns:Ada": {
    role: "The Teacher",
    blurb:
      "Ada is the experienced builder whose Pattern Book holds the shapes of solutions that have worked for years. Calm and dry humored, she teaches by asking one good question and then waiting for the answer. She is saving her book for a builder who will not only use it, but add pages of their own.",
  },
  "designpatterns:Nox": {
    role: "The Neighbor",
    blurb:
      "Nox is hopeful, a bit oblivious, and always in the middle of an errand when his lamp, his oven, or his flood bell lets him down. Every one of Basil's designs exists because a neighbor like Nox needed something to work. He reminds readers that good building starts with a real someone and a real problem.",
  },
  // Wally the Whale and the Great Harbor (docker)
  "docker:Wally": {
    role: "The Heavy Lifter",
    blurb:
      "Wally is the kind, slightly impatient whale who does the harbor's heavy work, carrying everyone's cargo to every island. His one wish is that each crate arrives exactly as it was packed, with no surprises along the way. He shows kids the quiet power of a helper who takes a job, does it the same way every time, and can be counted on.",
  },
  "docker:Pip": {
    role: "The Packer",
    blurb:
      "Pip the sea otter is a curious little maker who packs each crate with everything it needs for the journey. Nothing delights Pip more than a box packed perfectly, lid down, ready for any island. Pip stands for the care that happens before the trip: getting your work ready so it can travel anywhere.",
  },
  "docker:Skipper": {
    role: "The Harbor Caller",
    blurb:
      "Skipper is loud, bossy, and kind underneath it all, and the whole harbor runs on his calls. His job is to give clear orders, so Wally knows what to carry and where it needs to go. He shows young readers that good instructions are a kindness: say it plainly, and everyone can do their part.",
  },
  // Juno the Swift and the Wide Sky (motivationmanifesto)
  "motivationmanifesto:Juno": {
    role: "The Sky Seeker",
    blurb:
      "Juno is quick and funny, even when she is nervous, and she is done with the small sky she grew up in. She wants to fly beyond the town and choose her own sky, though part of her is afraid of wanting more. Her story tells kids that freedom is not handed over. It is flown, one brave choice at a time.",
  },
  "motivationmanifesto:Tempo": {
    role: "The Clock Keeper",
    blurb:
      "Tempo the stork keeps the tower clock and the mornings, and he says very little while meaning every word of it. Unhurried and exact, he treats time like something worth respecting. He is looking for a keeper who will take the dawn seriously after him, and Juno is learning why that matters.",
  },
  "motivationmanifesto:Pell": {
    role: "The Flock Follower",
    blurb:
      "Pell is cheerful, friendly, and happiest when the whole flock is pleased with him. He follows the others even when they are flying in circles, because standing out feels scarier than being lost. Pell is the pull of the crowd inside every kid, and Juno's story is partly about loving him without following him.",
  },
  // Penny the Squirrel and the Acorn Orchard (richdadpoordad)
  "richdadpoordad:Penny": {
    role: "The Young Planter",
    blurb:
      "Penny is quick, curious, and honest about the thing that scares her: winter, and whether her family will be ready for it. She loves snacks a little too much and is learning to wait, one acorn at a time. Her story shows kids that money is not just what you gather. It is what you plant.",
  },
  "richdadpoordad:Bram": {
    role: "The Hard Worker",
    blurb:
      "Bram is strong, kind, and tired, and he believes the answer to every problem is more hours of work. Trading his whole day for acorns keeps his family fed, and it also keeps him worn out. He is every grown up who works hard the only way they know how, and Penny loves him too much to stop asking questions.",
  },
  "richdadpoordad:Hazel": {
    role: "The Orchard Keeper",
    blurb:
      "Hazel is in no rush at all, because her trees are working while she rests. She answers questions with questions and lets Penny figure things out at her own pace. She wants Penny to see what she sees before the first snow: planted acorns keep growing, and eaten acorns are gone by dinner.",
  },
  // Wren the Songbird and the Gray Fog (thewarofart)
  "thewarofart:Wren": {
    role: "The Singer",
    blurb:
      "Wren is small and warm hearted, with a beautiful voice she knows is beautiful, which somehow makes her fear worse. She wants to sing her own song at Fledging Day, in front of everyone, without freezing. Her story is for every kid with a gift and a block: bravery is not waiting until you stop feeling scared.",
  },
  "thewarofart:Cato": {
    role: "The One Who Shows Up",
    blurb:
      "Cato has sung his one dawn note on Song Rock for thirty years, in all weather, and he was scared plenty of those mornings. Slow, dry, and completely unbothered, he simply arrives, every single day, feeling or no feeling. He shows young readers what showing up looks like when it becomes a way of life.",
  },
  "thewarofart:the Fog": {
    role: "The Not-Today Voice",
    blurb:
      "The Fog never shouts. It arrives soft spoken and reasonable, carrying a sensible sounding excuse for why today is not the day. It wants Wren to wait until tomorrow, forever. The Fog is the pushback every kid feels right before the thing they most need to do, and naming it is the first way to beat it.",
  },
  // Tilda the Magpie and the Treasure That Sorted Itself (iwillteach).
  // A book in the workshop: not yet published, so no store page exists.
  "iwillteach:Tilda": {
    role: "The Joyful Spender",
    blurb:
      "Tilda is a magpie with a magpie's heart: if it shines, she wants it, and her nest above the Great Market Oak ends every week empty because of it. She dreams of riding the ferry to the Moonberry Festival, if only her coins would stop wandering off. Her story is about giving every coin a job, so the treasure starts sorting itself.",
  },
  "iwillteach:Bix": {
    role: "The Vault Keeper",
    blurb:
      "Bix keeps the Burrow Bank vault under Bramblebrook, where every animal's coins sleep in tidy, counted rows. Calm, methodical, and kinder than his gruff voice suggests, he believes money behaves best when it has a proper home. He is the one Tilda turns to when her nest turns up empty one time too many.",
  },
  "iwillteach:Rook": {
    role: "The Patient Grower",
    blurb:
      "Rook tends the Treasure Tree orchard at the edge of Bramblebrook, where planted coins grow slowly into trees that drop more coins every season. He speaks in seasons, never in seconds, and has never once been hurried by anybody. He is waiting to teach one young bird that growing takes time, and that time does the heavy lifting.",
  },
};

// The Otter's overview also ships in the Still Pool note that follows
// Mira's cast, together with the line naming her real opponent. (He is a
// full registry character with a sheet and gallery; the note remains as
// the storytelling frame for his part in Mira's book.)
export const STILL_POOL_NOTE = {
  otterRole: "The Shortcut",
  otterBlurb:
    "The Otter is charm with a plan. Slick, quick talking, and a little too eager to help, he talks Mira out of her good fishing spot with a story that is not true. He is the temptation of easy success, and the dry ditch at the end of it teaches Mira more than he ever meant to.",
  opponentLine:
    "Mira's hardest opponent is not another animal. It is her own impatience.",
};

// Story order per book: protagonist first, then the rest of the cast in
// bible order. Drives the index grouping, castmate rows and prev/next
// navigation on the character pages.
export const BOOK_CAST_ORDER: Record<string, string[]> = {
  mastery: ["Mira", "Ansel", "Dell", "The Otter"],
  algorithms: ["Fern", "Moss", "Orin"],
  compoundeffect: ["Maisie", "Jasper", "Willa"],
  designpatterns: ["Basil", "Ada", "Nox"],
  docker: ["Wally", "Pip", "Skipper"],
  motivationmanifesto: ["Juno", "Tempo", "Pell"],
  richdadpoordad: ["Penny", "Bram", "Hazel"],
  thewarofart: ["Wren", "Cato", "the Fog"],
  iwillteach: ["Tilda", "Bix", "Rook"],
};

// Longer detail-page copy per character: two short "Meet {name}"
// paragraphs plus one fun detail line. Keyed like CAST_OVERVIEWS.
export interface CastBio {
  bio: [string, string];
  fun: string;
}

export const CAST_BIOS: Record<string, CastBio> = {
  "mastery:Mira": {
    bio: [
      "Mira practices at the edge of the Still Pool every morning, long before the other animals are awake, because the masters in the old stories fished at dawn and she intends to be one of them. She already has a heron's whole toolkit: the stillness, the long legs, a strike quicker than a blink. What she is missing is the one tool that only practice can build.",
      "So she keeps a private score, strikes landed against strikes missed, and for a long while the misses win. Dell would happily call that a reason to go do something fun instead. Ansel just keeps fishing beside her, unhurried, which is its own lesson: the pool rewards the bird who stays. Mira's story is about the mornings after the exciting first morning, when showing up quietly becomes the skill itself.",
    ],
    fun: "Mira can stand so still that dragonflies land on her beak. She counts it as practice, not luck.",
  },
  "mastery:Ansel": {
    bio: [
      "Ansel fishes the same stretch of bank he has fished since before the path along it was a path. The other animals plan their mornings around his silhouette: if Ansel is standing in the shallows, the pool is open for business. He greets Mira's questions the way he greets everything, slowly, and sometimes the whole answer is one word and a long look at the water.",
      "Young herons find him maddening right up until they need him. He will not demonstrate twice, he will not explain the trick of it, and he absolutely will not fish for you. What he offers instead is company at the exact moment the work gets lonely, and a living example of what a whole life of mornings can make out of an ordinary bird.",
    ],
    fun: "The fish of the Still Pool know Ansel's shadow by heart. He still outwaits every single one of them.",
  },
  "mastery:Dell": {
    bio: [
      "Dell keeps track of hobbies the way other ducks keep track of bread: enthusiastically, and with no system at all. This month alone there has been a drum phase, a kite phase, and a brief but passionate career in competitive splashing. Mira's fishing is, to Dell, simply her current hobby, and he supports it at maximum volume.",
      "That is what makes him such good company and such a gentle problem. Dell is not lazy, and he is not wrong about fun. He is a whole philosophy with feathers: the belief that a day is for enjoying right now. Mira's story never asks readers to stop liking him. It just shows the difference between a friend who cheers for your dream and a life that makes room for it.",
    ],
    fun: "Dell has started eleven hobbies this year. His personal record for finishing one is Friday.",
  },
  "mastery:The Otter": {
    bio: [
      "The Otter dresses every suggestion like a favor. He drifts in with a compliment, agrees that Mira's spot is a fine spot, a lovely spot, and then mentions, almost as an afterthought, the place he would fish if he were serious about supper: a place that, strangely, he never fishes himself. His paws stay clean the whole conversation. That is the tell, if you know how to look for it.",
      "Around the pool he is known as the animal who has never once been seen doing the slow version of anything. He hands out shortcuts like gifts, especially to anyone young enough to still believe a gift can be free. Mira's story lets readers watch the sales pitch from the outside, so they can spot the shape of it the next time one swims up to them.",
    ],
    fun: "The Otter knows every shortcut on the pond. He also knows every dry ditch at the end of them, personally.",
  },
  "algorithms:Fern": {
    bio: [
      "Fern plans an errand the way generals plan marches, except faster and with more tail. She can name the three quickest ways to the blackberry hedge and the exact stump where each route bogs down, because she has personally bogged down at all of them. Experience, for Fern, is mostly a list of shortcuts that betrayed her.",
      "Her den is where the thinking happens after the running: scratch maps in the dirt, pebbles lined up for the forks she cannot decide between, Moss's careful notes borrowed and returned with berry stains. Fern's story is about a mind that learns to love the planning as much as the dash, and about how a clever trail is usually just a lot of small, unglamorous decisions made in the right order.",
    ],
    fun: "Fern once raced a river. The river was not racing. She still tells everyone she nearly won.",
  },
  "algorithms:Moss": {
    bio: [
      "Moss writes things down the way other animals breathe: constantly, and without making a speech about it. His notebook rides along on every trip, and its pages hold the forest's practical memory: which berries ripen first, which log bridge ices over, which shortcut is only a shortcut in summer.",
      "Fern teases him about the pencil stubs. She also asks, at least once a week, to look something up. That is the friendship at the center of the trails: the fastest mind in the forest and the most careful one, checking each other's work. Moss shows readers that a good memory is not the opposite of cleverness. It is cleverness, saved up.",
    ],
    fun: "Moss's notebook has a waiting list. The other animals keep asking him to write their answers down too.",
  },
  "algorithms:Orin": {
    bio: [
      "Orin's great map hangs in a hollow at the top of the tallest pine, and half the forest assumes he simply knows everything from up there. The truth is less magical and more impressive: he checks. Every season he flies the boundary slowly, notes what the storms moved, and corrects the map line by line.",
      "Young animals bring him emergencies, and Orin has a habit that feels almost rude in a crisis: he asks about everything else first. Where does the trail start? Where does it need to end? What is in between? By the time Fern has answered, the huge problem is usually sitting in front of her in pieces small enough to carry, and she cannot quite say when that happened.",
    ],
    fun: "Orin can name every clearing in the forest. On quiet nights he names the clouds too, just to stay in practice.",
  },
  "compoundeffect:Maisie": {
    bio: [
      "Maisie's jar sits where she can see it from her bed, which is the point: she wants the winter store to be the first thing she thinks about and the last. She has opinions about grains the way collectors have opinions about stamps. The plump ones are for keeping, the scrawny ones are for supper, and every single one gets counted before it is allowed to be either.",
      "Her family thinks the promise is sweet. Willa, who has seen a hundred winters of good intentions, watches to see whether it survives a boring Tuesday. That is the real terrain of Maisie's story: not the day the promise is made, which is easy and exciting, but the long, ordinary stretch after, where a few grains at a time either become a habit or become a story about a habit.",
    ],
    fun: "Maisie counts her grains out loud as she adds them. The jar does not mind. The jar is used to it.",
  },
  "compoundeffect:Jasper": {
    bio: [
      "Jasper treats every work party like a picnic that somebody has rudely scheduled chores around. He is the first to volunteer for the snack run, the loudest singer on the carrying line, and the inventor of at least four systems for moving grain without technically moving. Two of them almost worked.",
      "Nobody in the warren doubts his heart; he would give away his own supper, and has. What he cannot yet give is his attention past the point where a job stops being interesting, and the soreness he feels about that is real too, even if he only admits it to himself. Jasper is in the story so readers can recognize the voice that negotiates with them daily, and like him anyway.",
    ],
    fun: "Jasper's record is carrying nine grains at once. He dropped eight. He ate the ninth on the way home.",
  },
  "compoundeffect:Willa": {
    bio: [
      "Willa's granary runs on rituals so old they have stopped looking like decisions. Grains are counted at dawn, never at dusk when eyes are tired, and the key turns twice, always twice. She speaks in small numbers and smaller sentences, and she receives every piece of exciting news the way she receives weather: with interest, and no movement whatsoever.",
      "Everyone assumes the key will go to the strongest carrier or the loudest volunteer when Willa is ready. Instead she watches for something rarer: a mouse whose small habits hold steady when nobody is checking. With Maisie she offers no lectures and no shortcuts. She makes tea, counts along under her breath, and lets one quiet week after another pile up as the whole argument.",
    ],
    fun: "Willa has never been in a hurry in her life, including the winter the granary roof leaked. The roof waited too.",
  },
  "designpatterns:Basil": {
    bio: [
      "Ask Basil about building and he will show you his paws, his tail, and whatever he is working on, in that order. He treats every job like the whole creek is watching, from a grand dam down to a wobbly footbridge for Nox, because that is how he understands trust: not one big triumph, but every small repair done right.",
      "The patterns in Ada's book are old because they survived every season that tried to wash them out. Basil's story follows him from copying those shapes exactly to understanding them well enough to change one on purpose, and that is when Ada starts watching him the way the whole creek watches her.",
    ],
    fun: "Basil names his dams. The current one is called Perseverance, because the first name he picked did not hold water.",
  },
  "designpatterns:Ada": {
    bio: [
      "Ada's workshop is the calmest place on the creek, and also the hardest to impress. Builders bring her their proudest work, and she looks at it the way water looks at a dam: patiently, and entirely concerned with where it will give. Then she asks the one question they were hoping nobody would ask, and the room goes quiet in the useful way.",
      "Her Pattern Book mostly stays closed on its shelf, which drives the young builders half mad. Ada is not hoarding it. She is reading them the way she reads joinery, looking for the one who will treat the old shapes as a beginning instead of a cage. Basil, who would like the book handed over by Friday, is learning that some tests you pass by not asking about the test.",
    ],
    fun: "Ada's Pattern Book has a waiting list of builders hoping to be the one she finally gives it to.",
  },
  "designpatterns:Nox": {
    bio: [
      "Nox starts every day with a list, and the list is excellent. By midmorning the list is usually in a different burrow from Nox, and Nox is doing an errand that was scheduled for Thursday with a lamp that gave up sometime in March. His neighbors have stopped being surprised. They have also, quietly, started building a little Nox room into their plans.",
      "He is Basil's best argument without knowing it. Every design meeting at the creek eventually comes down to the same question: would this work for Nox, on a wet Tuesday, in a hurry, with one paw full? If the answer is yes, the design is probably honest. Nox shows readers that the neighbor whose things keep breaking is not the problem with the system. He is the reason the system exists.",
    ],
    fun: "Nox owns three lamps, two ovens and one flood bell. On any given day, exactly two of them work. It is never the same two.",
  },
  "docker:Wally": {
    bio: [
      "Wally loads at dawn, when the harbor water is flat and the gulls are still arguing about who gets the good post. He knows every island's dock by its squeak, every captain's handwriting, and exactly how a crate should feel when it is balanced right on his back. The crooked cap is not carelessness. It has survived hundreds of crossings, and he considers it crew.",
      "What the harbor folk understand, and visitors sometimes miss, is that Wally is not really in the carrying business. He is in the keeping business: your crate, kept sealed, kept dry, kept exactly itself, from your dock to the far dock. That is why a whole harbor trusts one whale with everything it owns, and why his rare bad mood is treated like weather: noted, respected, and waited out.",
    ],
    fun: "Wally can carry forty crates at once, and he has strong opinions about how lids should fit.",
  },
  "docker:Pip": {
    bio: [
      "Pip's packing bench is the tidiest square of the harbor, and the only one where the string is sorted by length. He interviews every crate like it is going somewhere important, because to Pip it is: padding where it rattles, weight where it balances, and a list inside the lid written in his round, careful hand.",
      "The other animals tease that Pip packs for journeys the crate will never take. Then the fog comes down, or the crossing runs long, or a crate spends a night on the wrong dock, and everybody quietly stops teasing until the next sunny week. Pip is the reason those stories end boringly, and he considers a boring arrival the finest compliment there is.",
    ],
    fun: "Pip packs a spare of everything. Including a spare spare. It has come in handy exactly once, and he mentions it often.",
  },
  "docker:Skipper": {
    bio: [
      "Skipper rehearses the morning calls the night before, alone on his post, at full volume, because a call that cannot survive rehearsal will not survive a harbor. Each order he gives has a shape the crews know by heart: what, where, how many, and nothing extra for the wind to argue with.",
      "Underneath the shouting is a worrier. Skipper keeps a private list of every misunderstanding the harbor has ever had, and most of his famous volume is an attempt to make sure none of them happen twice. When a call lands wrong, he takes it personally, replays it all evening, and comes back at dawn saying it plainer. The crews grumble about the noise. They would riot over the silence.",
    ],
    fun: "Skipper's morning call can be heard on three islands. The fourth island pretends not to hear it, but it hears it.",
  },
  "motivationmanifesto:Juno": {
    bio: [
      "Juno navigates by landmarks the way other birds navigate by the sun, except her landmarks are all places she has been told not to bother with: the far ridge, the river's bend, the line where the town's sky officially runs out. She visits them in her head during chores. She has the routes memorized for a journey she has not yet admitted she is taking.",
      "Her humor is the tell. Juno jokes fastest when she is scared, and the flock has learned to hear the difference even if she wishes they could not. Tempo hears it too, from up in the tower, and says nothing, which is his way of leaving the door open. Juno's story is about the moment a bird stops treating her own wanting like a rumor and starts treating it like a heading.",
    ],
    fun: "Juno has names for the winds over the pine ridge. The pushy one has a name she only says mid-flight.",
  },
  "motivationmanifesto:Tempo": {
    bio: [
      "Tempo's day is a series of small ceremonies nobody assigned him: the tower steps swept before the climb, the clock key hung on the same hook every night, the first look at the town taken standing perfectly still, as if the morning were a guest he did not want to startle.",
      "The town does not know it runs on him, which he considers the correct arrangement. Juno knows, because Juno watches from the ridge and has started, without deciding to, arriving places when she said she would. Tempo shows readers a kind of strength that never raises its voice: the strength of a promise so regular that other people's lives quietly set themselves by it.",
    ],
    fun: "Tempo has wound the tower clock every morning for as long as anyone remembers. The whole town sets its breakfast by him.",
  },
  "motivationmanifesto:Pell": {
    bio: [
      "Pell can read a flock the way sailors read clouds. He knows which way the group is leaning before the group does, and he is already leaning with it, cheerfully, feathers smooth. Ask him privately where he would fly and he will answer honestly, then glance around to check whether honest was the popular choice.",
      "It would be easy to make Pell the lesson and leave it there. Juno cannot, because Pell is also the friend who saves her the warm spot on the wire and laughs like a bell at her worst jokes. His story asks a harder question than how to stand out: how to love the crowd, and be loved by it, without handing it the map to your whole life.",
    ],
    fun: "Pell once followed the flock in one complete circle and told everyone afterward that it was a tour.",
  },
  "richdadpoordad:Penny": {
    bio: [
      "Penny keeps her acorns in three piles and her worries in one big one. The piles are eating, sharing, and a third, newer pile that lives at the back of the hollow, where snacking paws cannot reach it in a moment of weakness. She visits the third pile the way you visit a sleeping baby: quietly, and mostly to make sure it is still there.",
      "She asks Bram her questions at breakfast, Hazel hers at the orchard gate, and herself the same question all day long: what is this one for? That question is the whole engine of her story. An acorn with a job stops being a snack that got away, and Penny is discovering, pile by pile, that the asking itself is a kind of growing.",
    ],
    fun: "Penny keeps one emergency acorn tucked in her cheek at all times. It has been replaced many, many times.",
  },
  "richdadpoordad:Bram": {
    bio: [
      "Bram's day starts before the sun has an opinion about it. He has a route through the woods he could walk asleep, a carrying rhythm the younger squirrels try to copy and cannot, and a belief worn smooth as his favorite strap: that rest is something you earn at the end of the pile, not along the way to it.",
      "Penny's questions land on him at the tired end of the day, which is exactly when they matter. He could swat them away; fathers everywhere have the technique. Instead he listens with his whole aching back, because some part of him suspects the questions are not really about acorns. Bram is in the story to honor every parent who was never given a second way to think about work, and who listens anyway.",
    ],
    fun: "Bram can carry a whole day's acorns in a single trip. His back has filed a formal complaint, which he has not read.",
  },
  "richdadpoordad:Hazel": {
    bio: [
      "Hazel's orchard keeps its own calendar, and it is not the one the squirrels argue about at the market. She knows which tree sulks after a wet spring, which one pays early, and which hollow trunk keeps the rain off a thinking squirrel. Her cane is less for walking than for pointing: at a graft, at a shadow line, at next year's lunch growing quietly overhead.",
      "Visitors leave her gate a little frustrated, carrying a question instead of an answer, and that is the design. Hazel has learned that a lesson told is forgotten by supper, while a lesson found is kept. So she feeds Penny tea and silence in equal measure, and trusts the trees, and the season, to finish every sentence she starts.",
    ],
    fun: "Hazel planted her first tree before Penny was born. It now shades her whole porch, and two of Bram's opinions.",
  },
  "thewarofart:Wren": {
    bio: [
      "Wren treats her voice the way athletes treat a good leg. No shouting across the pond. Every new line of the song is tested quietly before it is allowed into the whole. The song she is writing for Fledging Day has a high part she has only ever landed alone, and she tends it the way gardeners tend the one plant that matters most.",
      "That is the knot of her: it is not the singing she fears, it is the watching. One pair of kind eyes can undo her for an hour, and Fledging Day is every pair of eyes she knows, gathered in one place, on purpose. Cato, who has sung scared in front of the whole shore for thirty years, is her proof that a song does not need the fear to leave before it can start. It just needs the singer to arrive with it.",
    ],
    fun: "Wren practices her song to the reeds at the pond's edge, because reeds never look expectant.",
  },
  "thewarofart:Cato": {
    bio: [
      "Cato's whole performance takes about four seconds, and he has spent thirty years protecting those four seconds like they were a fortune. He does not warm up where anyone can make a fuss about it. He simply appears at Song Rock the way sunrise appears, as if arriving were the entire technique, which, for Cato, it mostly is.",
      "The young birds keep waiting for his secret and keep being disappointed by the furniture of it: same stone, same note, same hour, in weather that would excuse anybody. What Cato knows, and cannot hand over in words, is that the Fog loses interest in a bird with no negotiations left in him. He does not win the morning. He has just stopped holding a meeting about it.",
    ],
    fun: "Cato has sung in rain, frost, and one memorable hailstorm. The note did not change. Neither did he.",
  },
  "thewarofart:the Fog": {
    bio: [
      "The Fog has excellent timing and terrible intentions. It does not bother Wren on lazy afternoons, when nothing is at stake. It comes at the exact moment she opens her beak, or thinks about opening it, and it comes dressed as her own common sense, using her own voice, at a reasonable volume.",
      "Its favorite trick is that it never says no. No would be easy to argue with. It says later, and later, and later, in a tone so sensible that arguing feels rude. The birds who beat it are never the ones who outshout it. They are the ones who learn to hear the difference between wisdom and a postponement wearing wisdom's coat. Once Wren can tell those two apart, the Fog is mostly weather.",
    ],
    fun: "The Fog's favorite day is tomorrow. Somehow, it is always tomorrow.",
  },
  "iwillteach:Tilda": {
    bio: [
      "Tilda shops the Great Market the way weather moves through it: everywhere at once, and delighted by all of it. She knows every stallholder by name, every ferry schedule by heart, and the exact sparkle a coin makes when the morning sun hits the stalls at the right angle. Spending, for Tilda, is not carelessness. It is a celebration she keeps throwing with money that had other plans.",
      "Her friends have tried budgets on her the way you would try on a hat: kindly, and briefly. What works better is furniture: a nest arranged so a coin knows where it lives the moment it comes home, and a festival fund with a view of the ferry dock, so saving has a face too. Tilda's story is about discovering that sorting your treasure is not the end of the fun. It is how the fun affords to keep happening.",
    ],
    fun: "Tilda can spot a shiny coin from the very top of the Market Oak. Saving it after she lands is the hard part.",
  },
  "iwillteach:Bix": {
    bio: [
      "Bix opens the Burrow Bank the way other animals open a ceremony: visor straight, spectacles polished, ledger squared to the table's edge like it is about to be inspected by the king of badgers. Depositors who arrive mid-hustle find themselves mysteriously slowing down at his window. The vault has a pace, and the pace is his.",
      "He keeps a private column in the ledger that no auditor will ever see: not amounts, just names, and what the saving is for. A boat. A wedding. One young magpie's ferry ticket, entered in pencil, because Bix does not presume. He shows readers that careful is not the opposite of kind. Careful is what kind looks like when it is in charge of other people's dreams.",
    ],
    fun: "Bix counts the whole vault every night before locking up. The coins sleep better counted. So does Bix.",
  },
  "iwillteach:Rook": {
    bio: [
      "Rook's orchard gate has no latch, because Rook has never met a visitor who needed keeping out or a hurry that needed letting in. He walks his rows at the speed of the trees themselves, checking a graft here, sitting a while there, in the manner of a fellow for whom the difference between working and resting was settled long ago and is no longer discussed.",
      "Animals come to him wanting a date: when will it pay, when will it be enough, when can we stop waiting. Rook answers in moons and leaf-falls, which maddens them for exactly one visit. By the second visit they are walking slower at his gate without noticing. That is his real crop, the one between the trees: neighbors who have learned to let a good plan finish becoming itself.",
    ],
    fun: "Rook once waited an entire season before answering a question. The answer was yes. It had been yes all along.",
  },
};

// The Otter's full detail-page copy (also keyed as "mastery:The Otter"
// in CAST_BIOS above; kept as a named export for reference).
export const OTTER_BIO: CastBio = {
  bio: [
    "The Otter dresses every suggestion like a favor. He drifts in with a compliment, agrees that Mira's spot is a fine spot, a lovely spot, and then mentions, almost as an afterthought, the place he would fish if he were serious about supper: a place that, strangely, he never fishes himself. His paws stay clean the whole conversation. That is the tell, if you know how to look for it.",
    "Around the pool he is known as the animal who has never once been seen doing the slow version of anything. He hands out shortcuts like gifts, especially to anyone young enough to still believe a gift can be free. Mira's story lets readers watch the sales pitch from the outside, so they can spot the shape of it the next time one swims up to them.",
  ],
  fun: "The Otter knows every shortcut on the pond. He also knows every dry ditch at the end of them, personally.",
};
